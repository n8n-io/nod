---
title: Configuration reference
description: Every setting a source install of Otto reads from .env, what it does and its default value.
sidebar:
  order: 1
---

This page lists the settings a source install of Otto reads, what each one does and its default.

## How settings work

- Settings live in `.env` in the repository folder. Git ignores it. `pnpm start` creates it from `.env.example` the first time, readable only by you.
- A variable set in your shell wins over the same variable in `.env`.
- Otto reads settings when it starts. Restart Otto after you change one.
- Most things don't need a variable. You connect models, apps and channels in the app, and Otto saves them encrypted.
- The desktop app doesn't read `.env`. It manages its own settings in **Settings**.

```mermaid
flowchart LR
  shell[Shell variable]:::accent -- wins over --> file[.env]
  file --> server[Otto server<br/>reads at start]
  app[Settings in the app] --> db[(Encrypted<br/>in the database)]
  db --> server
```

## Server and data

| Variable                 | What it does                                                                                                                                            | Default         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `PORT`                   | The local port for the app and API.                                                                                                                     | `4310`          |
| `OTTO_DATA_ROOT`         | The folder for local data: sessions, workspace files and the access key.                                                                                | `.local`        |
| `OTTO_POSTGRES_PASSWORD` | The password of the local PostgreSQL container. `pnpm start` generates one and saves it. A value you set needs at least 43 letters, digits, `_` or `-`. | Generated       |
| `DATABASE_URL`           | The PostgreSQL connection. `pnpm start` fills it in for the local container on `127.0.0.1:54329`. Set another URL to use your own database.             | Local container |
| `DATABASE_POOL_MAX`      | The most database connections the server opens.                                                                                                         | `12`            |

## Models

Keys set here become server-managed connections. They stay in server memory and aren't copied into the database. You can also add connections in **Models** without any variable. See [Models](/connect/models/).

| Variable             | What it does                                                                                                                                      | Default                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `LLM_PROVIDER`       | The provider of the first model choice: `openai`, `anthropic` or `openrouter`. A model you pick in the app takes priority.                        | `openai`                                                              |
| `LLM_MODEL`          | The first model choice.                                                                                                                           | `gpt-6.1-sol`, `claude-opus-5-5` or `openai/gpt-6.1-sol`, by provider |
| `OPENAI_API_KEY`     | Adds an OpenAI connection. It also turns on voice replies.                                                                                        | Empty                                                                 |
| `ANTHROPIC_API_KEY`  | Adds an Anthropic connection.                                                                                                                     | Empty                                                                 |
| `OPENROUTER_API_KEY` | Adds an OpenRouter connection.                                                                                                                    | Empty                                                                 |
| `TYPESAFE_API_KEY`   | Uses Typesafe's Jev model to decide whether a connected-app event, such as a new email, should wake Otto. Without it, the selected model decides. | Empty                                                                 |
| `TYPESAFE_MODEL`     | The Jev model name.                                                                                                                               | `jev-latest`                                                          |
| `TTS_MODEL`          | The OpenAI speech model for voice replies.                                                                                                        | `gpt-4o-mini-tts`                                                     |
| `TTS_VOICE`          | The voice for voice replies. Not in `.env.example`.                                                                                               | `coral`                                                               |

## Apps and Composio

| Variable                           | What it does                                                                                                           | Default   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| `COMPOSIO_API_KEY`                 | Your Composio project key for Gmail, Calendar, Slack and other apps. You can paste it in onboarding instead.           | Empty     |
| `COMPOSIO_WEBHOOK_SECRET`          | Verifies Composio webhook deliveries for automatic app updates. The key then also needs **Triggers → Read and write**. | Empty     |
| `COMPOSIO_GMAIL_AUTH_CONFIG_ID`    | Picks the Composio auth config, and so the OAuth scopes, for Gmail.                                                    | Automatic |
| `COMPOSIO_CALENDAR_AUTH_CONFIG_ID` | The same for Google Calendar.                                                                                          | Automatic |
| `COMPOSIO_DRIVE_AUTH_CONFIG_ID`    | The same for Google Drive.                                                                                             | Automatic |
| `COMPOSIO_SHEETS_AUTH_CONFIG_ID`   | The same for Google Sheets.                                                                                            | Automatic |
| `COMPOSIO_DOCS_AUTH_CONFIG_ID`     | The same for Google Docs.                                                                                              | Automatic |
| `COMPOSIO_SLACK_AUTH_CONFIG_ID`    | The same for Slack.                                                                                                    | Automatic |
| `COMPOSIO_NOTION_AUTH_CONFIG_ID`   | The same for Notion.                                                                                                   | Automatic |

"Automatic" means that, for Google apps, Otto uses the project's one enabled custom OAuth config. Otherwise Composio's project default applies. See [Apps](/connect/apps/) for the key permissions.

## Vault

| Variable         | What it does                                                                                                                                                                                      | Default |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `OTTO_VAULT_KEY` | A base64 32-byte key that encrypts saved logins, cards, model keys and the Composio key. Required outside macOS. On macOS, if it's empty, Otto keeps a key in the Keychain item `dev.otto.vault`. | Empty   |

Create a key with `openssl rand -base64 32`.

:::danger[Back up the Vault key]
Saved credentials can't be read without it. Keep a copy somewhere safe, outside the repository.
:::

## Channels

Set up Telegram and WhatsApp in **Channels** instead. The app checks the account and saves the settings encrypted, and those override these variables. See [Channels](/use/channels/).

| Variable                        | What it does                                                                             | Default |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ------- |
| `TELEGRAM_ENABLED`              | `true` turns on Telegram.                                                                | `false` |
| `TELEGRAM_BOT_TOKEN`            | The bot token from BotFather.                                                            | Empty   |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | The secret Telegram sends with each webhook call: 16 to 256 letters, digits, `_` or `-`. | Empty   |
| `TELEGRAM_ALLOWED_USER_ID`      | The only Telegram user ID Otto answers.                                                  | Empty   |
| `WHATSAPP_ENABLED`              | `true` turns on WhatsApp.                                                                | `false` |
| `WHATSAPP_POLICY_CONFIRMED`     | `true` confirms your use is allowed under the WhatsApp terms. Required.                  | `false` |
| `WHATSAPP_ACCESS_TOKEN`         | The WhatsApp Cloud API access token from Meta.                                           | Empty   |
| `WHATSAPP_APP_SECRET`           | The Meta app secret. Otto uses it to check webhook signatures.                           | Empty   |
| `WHATSAPP_PHONE_NUMBER_ID`      | The ID of the business sender number.                                                    | Empty   |
| `WHATSAPP_VERIFY_TOKEN`         | The token Meta sends when it verifies the webhook.                                       | Empty   |
| `WHATSAPP_ALLOWED_NUMBER`       | The only phone number Otto answers, 7 to 15 digits.                                      | Empty   |

## Analytics and feedback

| Variable                     | What it does                                                                                                                       | Default                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `OTTO_ANALYTICS_ENABLED`     | `false` turns off usage data and recordings for everyone. `true` turns them on in development too. Each owner still has to opt in. | On with `pnpm start`, off with `pnpm run dev` |
| `OTTO_ANALYTICS_ENVIRONMENT` | The label on events: `production` or `development`.                                                                                | Follows how you started Otto                  |
| `OTTO_FEEDBACK_URL`          | The HTTPS address that receives **Send feedback** reports. An empty value turns submission off.                                    | The Otto team at n8n                          |

See [Analytics and recordings](/deploy/analytics/) for what's collected.

## Computers

| Variable              | What it does                                                                                                    | Default          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| `COMPUTER_PROVIDER`   | Where the workspace and browser run: `docker` on your computer, `e2b`, or `cloudflare` for hosted tenants only. | `docker`         |
| `WORKSPACE_CONTAINER` | The Docker container for the workspace.                                                                         | `otto-workspace` |
| `BROWSER_CONTAINER`   | The Docker container for the browser.                                                                           | `otto-browser`   |

## Hosted only

A hosted deployment sets these in its `GATEWAY_ENV` secret. A source install leaves them unset. See [Hosted on Cloudflare](/deploy/cloudflare/).

| Variable                                                         | What it does                                                               | Default                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| `OTTO_MODE`                                                      | `local`, `gateway` or `tenant`.                                            | `local`                   |
| `OTTO_ENVIRONMENT`                                               | `development` or `production`.                                             | `development`             |
| `OTTO_PUBLIC_URL`                                                | The public HTTPS origin.                                                   | `http://localhost:<PORT>` |
| `OTTO_MASTER_KEY`                                                | The key Otto derives each user's keys from. Treat it as recovery material. | None                      |
| `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in.                                                            | None                      |
| `OTTO_MAX_USERS`                                                 | The most accounts the deployment admits, up to 400.                        | `8`                       |
| `OTTO_DEVELOPER_IDS`                                             | Comma-separated account IDs that can use the developer browser routes.     | Empty                     |
| `OTTO_PRIVACY_NOTICE_FILE`                                       | A Markdown privacy notice served at `/privacy`.                            | No notice                 |
| `OBJECT_STORAGE_PROVIDER`, `OBJECT_STORAGE_ENDPOINT`             | Where files and checkpoints are stored.                                    | None                      |
| `E2B_API_KEY`, `E2B_COMPUTER_TEMPLATE`                           | Required when `COMPUTER_PROVIDER=e2b`.                                     | None                      |

## Related resources

- [Install from source](/get-started/install-from-source/)
- [Desktop app internals](/deploy/desktop-app/)
- [Hosted on Cloudflare](/deploy/cloudflare/)
- [Troubleshooting](/deploy/troubleshooting/)
