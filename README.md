# Otto

Otto is a personal assistant you use through one chat. Each owner has one persistent thread with its own Linux workspace and browser, so Otto can research, run commands, create files, use connected apps, run schedules and reply on Telegram or WhatsApp. See [architecture](docs/architecture.md) for how it works.

## Local setup

Requirements: Node.js 24.21.0 or newer and Docker with Compose v2 (start Docker Desktop on Mac). From the repository root:

```sh
npm start
```

The first run installs dependencies, creates `.env`, and starts PostgreSQL plus the workspace and browser containers. Each start builds the web app and runs it in production mode. Open [http://localhost:4310](http://localhost:4310). Local mode serves one owner on `127.0.0.1` with no login.

For development with automatic reload, use `npm run dev`. Development analytics and recordings are disabled by default.

Configuration lives in the ignored `.env` (all local settings are listed in `.env.example`; shell variables take priority; restart after edits):

| Setting                        | Needed for                                                |
| ------------------------------ | --------------------------------------------------------- |
| Model connection in **Models** | Chat with a key, ChatGPT plan, or OpenRouter              |
| `COMPOSIO_API_KEY`             | Managed app integrations and the available-app catalog    |
| `OTTO_VAULT_KEY`               | Vault encryption on non-macOS hosts (macOS uses Keychain) |
| `DEV_INSPECTOR=false`          | Disables the Inspector view (on by default locally)       |

Notion and Linear connect through their hosted MCP servers without extra keys. Telegram and WhatsApp are configured from the **Channels** page.

`npm start`, production hosted deployments and packaged desktop apps include PostHog product analytics and masked recordings. Set `OTTO_ANALYTICS_ENABLED=false` in `.env` to disable local collection, then restart. See [analytics and recording boundaries](docs/analytics.md) for the dashboard, event contract, controls and validation.

### Composio key permissions

In the [Composio Dashboard](https://dashboard.composio.dev), open **Platform → your project → Settings → API Keys → Create API Key** and create a scoped project key with these permissions:

| Permission area        | Access         | Used by Otto                                                                     |
| ---------------------- | -------------- | -------------------------------------------------------------------------------- |
| Connected accounts     | Read and write | Check connections and disconnect accounts                                        |
| Session management     | Read and write | Create, restore and delete sessions; open app sign-in links                      |
| Session tool execution | Write only     | Find app actions, load their schemas and run them                                |
| Toolkits               | Read only      | Discover available integrations before connecting an account                     |
| Auth configs           | Read only      | Select the project's custom Google OAuth config when no explicit override exists |
| Proxy execute (Legacy) | Write only     | Read account identity, check Gmail updates and retrieve requested sign-in emails |

Auth configs read is needed only for automatic Google auth-config selection; explicit overrides and other apps do not use that lookup. The existing alpha Full access key already covers it. Leave **Tools**, **Triggers**, **Webhooks**, **Observability**, **MCP (Legacy)** and **Tool execution (Legacy)** at **No access**. If you configure `COMPOSIO_WEBHOOK_SECRET` for automatic app updates, also grant **Triggers → Read and write**: the SDK reads trigger definitions before creating subscriptions, and Otto removes subscriptions when disconnected. Otto does not manage Composio webhook endpoints through the API.

Paste the key in the onboarding email step of local web Otto, which checks it with Composio and saves it encrypted with the Vault key, or copy it into `COMPOSIO_API_KEY` in the repository's ignored `.env` and restart Otto. Then connect apps from **Apps**. Keep the key on the server. Permissions cannot be edited after creation; create a replacement key if a permission is missing. A valid key with insufficient permissions can produce an “Invalid API key” error. See Composio's [permission route map](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions) and [permission troubleshooting](https://docs.composio.dev/kb/guide/platform-project-api-key-permissions).

These are permissions on the **Composio project key**. The Google or Slack consent screen separately controls what Otto can read or change in that account. The selected auth config controls app OAuth scopes; a `COMPOSIO_*_AUTH_CONFIG_ID` from `.env.example` explicitly selects that config. To narrow those grants, configure the required app scopes in that auth config and reconnect existing accounts; changing the project key does not change app consent. See [Controlling scopes](https://docs.composio.dev/docs/authentication/controlling-scopes).

The **Apps** page loads a searchable catalog of Composio integrations with managed authentication or dynamic OAuth registration. The agent uses the same catalog through `manage_apps discover`, then offers a private connection link. Catalog access requires **Toolkits → Read**; older keys without it retain their existing connections and featured apps. Notion and Linear continue to prefer their official MCP connections. Native MCP toolkits with managed authentication or dynamic registration work through Composio; other MCP servers, HTTP APIs and installed CLIs use the agent's discovery and secure setup flow.

Active isolated development and the trusted internal alpha share `otto_alpha_release`. Alpha participants enter its project key; they do not need to enter Google auth-config IDs. A desktop operator can recover that key and use its project-wide permissions outside Otto. Sharing it is appropriate only with people trusted to access that Composio project; wider distribution needs customer-owned projects or an authenticated broker. Local encryption and Otto's owner IDs do not isolate a shared project key.

When starting Gmail, Calendar, Drive, Sheets or Docs sign-in without an explicit override, Otto reads that project's auth configs and selects its unique enabled custom OAuth2 config enabled for Tool Router. Explicit overrides win. Multiple eligible configs, or enabled custom OAuth2 configs with none available to Tool Router, stop sign-in with a configuration error. When no enabled custom OAuth2 config exists, Composio's project default remains in effect. This lookup occurs only during authorization and does not change existing accounts or other managed/DCR app flows.

Development uses an isolated profile; the older normal local profile remains on `otto_development` with its existing connections. Do not replace a profile's project key beneath saved account IDs. Prefer managed authentication where it works and retain custom configs where needed. Otto's own Google login configuration is independent and stays in place.

Cloudflare work is deferred for this release; no saved or deployed Cloudflare configuration was changed. Reviewed on 2026-10-07 against [`@composio/core` 0.21.0 and Otto's adapter](src/providers/composio/integrations.ts); the table covers the calls Otto makes.

### Models

Onboarding walks through six steps: welcome, a model connection, three short questions about your work (saved as notes you wrote), Gmail, Telegram, and an opt-in for usage data, which is off by default. Existing server connections appear automatically. The model step continues once a model is selected; Gmail and Telegram can be skipped. After setup, the first chat suggests three tasks with a **Do it** button that sends the task title as your message. An empty chat shows **Connect a model** until a model is ready. Open **Models** from the account menu to manage connections. Add an OpenAI, Anthropic, or OpenRouter API key. You can also connect a ChatGPT plan in local Otto or connect an OpenRouter account through browser sign-in. Otto opens the system browser in the desktop app and a new tab on the web. The connection and model list update when sign-in completes. If the callback cannot open, paste its URL under **Complete sign-in**. The server encrypts saved credentials with the Vault key. macOS uses Keychain; other hosts need `OTTO_VAULT_KEY`.

The first connection selects GPT-6.1 Sol at high effort, or Claude Opus 5.5 at high effort for Anthropic, when that model is available. If the default is unavailable, choose a listed model. Choosing a model uses high effort where the model supports it. Click the model name above chat to search or switch models. The next turn uses the saved choice in every channel and keeps the Pi conversation. A running turn keeps its model. Connections do not change on errors. Pi retries a model request that fails with a temporary provider error (overload, rate limit, server or network error) up to three times; turns and tool calls are never retried.

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY` remain server-managed connections. `LLM_PROVIDER` and `LLM_MODEL` set the initial choice. Saved choices take priority after that. Memory and event relevance use the selected connection and a smaller compatible model where available. `TYPESAFE_API_KEY` retains the Jev relevance option. Voice uses the separate OpenAI key in server settings.

Claude subscriptions do not permit direct token use in Otto. Use an Anthropic API key or OpenRouter. A Claude Code runtime needs separate session and safety checks before release. Hosted ChatGPT plan use needs OpenAI access. See [model connection details](docs/model-connections.md).

Ports: 4310 local app, 4330 hosted development (`node scripts/start-hosted.mjs`, see [Cloudflare](deployment/cloudflare/README.md)), 4320 E2E harness.

Ctrl-C stops the server; `docker compose stop` stops the containers. Data stays in `.local/` and Docker volumes.

## Task skills

Otto has a server skill library for common tasks. The model sees skill names and descriptions, then reads the required guide and references through the `skills` tool. Guides help with task decisions and result checks. They do not add tools or permission. See [skill library](docs/skill-library.md).

## Checks

```sh
npm run check             # types, import boundaries, formatting
npm test                  # deterministic tests (database cases skip without TEST_DATABASE_URL)
npm run test:integration  # all tests in Linux with disposable PostgreSQL and Chromium
npm run build             # types and web bundle
```

The integration command builds the client and browser image, runs every test in an isolated Docker network, and removes its test containers afterward. It fails on skipped tests and does not use your local database or credentials.

Hosted deployment: [deployment/cloudflare/README.md](deployment/cloudflare/README.md). Rules for coding agents: [AGENTS.md](AGENTS.md).
