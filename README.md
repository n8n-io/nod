# Otto

Otto is a personal assistant you use through one chat. Each owner has one persistent thread with its own Linux workspace and browser, so Otto can research, run commands, create files, use connected apps, run schedules and reply on Telegram or WhatsApp. See [architecture](docs/architecture.md) for how it works.

## Local setup

Requirements: Node.js 24.21.0 or newer and Docker with Compose v2 (start Docker Desktop on Mac). From the repository root:

```sh
npm run dev
```

The first run installs dependencies, creates `.env`, and starts PostgreSQL plus the workspace and browser containers. Open [http://localhost:4310](http://localhost:4310). Local mode serves one owner on `127.0.0.1` with no login.

Configuration lives in the ignored `.env` (all local settings are listed in `.env.example`; shell variables take priority; restart after edits):

| Setting                                  | Needed for                                                |
| ---------------------------------------- | --------------------------------------------------------- |
| `LLM_PROVIDER=openai` + `OPENAI_API_KEY` | Chat (required; or `anthropic` + `ANTHROPIC_API_KEY`)     |
| `COMPOSIO_API_KEY`                       | Gmail, Calendar, Drive, Sheets, Docs, Slack               |
| `OTTO_VAULT_KEY`                         | Vault encryption on non-macOS hosts (macOS uses Keychain) |
| `DEV_INSPECTOR=false`                    | Disables the Inspector view (on by default locally)       |

Notion and Linear connect through their hosted MCP servers without extra keys. Telegram and WhatsApp are configured from the **Channels** page.

### Composio key permissions

In the [Composio Dashboard](https://dashboard.composio.dev), open **Platform → your project → Settings → API Keys → Create API Key** and create a scoped project key with these permissions:

| Permission area        | Access         | Used by Otto                                                                     |
| ---------------------- | -------------- | -------------------------------------------------------------------------------- |
| Connected accounts     | Read and write | Check connections and disconnect accounts                                        |
| Session management     | Read and write | Create, restore and delete sessions; open app sign-in links                      |
| Session tool execution | Write only     | Find app actions, load their schemas and run them                                |
| Proxy execute (Legacy) | Write only     | Read account identity, check Gmail updates and retrieve requested sign-in emails |

Leave **Auth configs**, **Tools**, **Toolkits**, **Triggers**, **Webhooks**, **Observability**, **MCP (Legacy)** and **Tool execution (Legacy)** at **No access**. If you configure `COMPOSIO_WEBHOOK_SECRET` for automatic app updates, also grant **Triggers → Read and write**: the SDK reads trigger definitions before creating subscriptions, and Otto removes subscriptions when disconnected. Otto does not manage Composio webhook endpoints through the API.

Copy the key into `COMPOSIO_API_KEY` in the repository's ignored `.env`, restart Otto, then connect apps from **Apps**. Keep the key on the server. Permissions cannot be edited after creation; create a replacement key if a permission is missing. A valid key with insufficient permissions can produce an “Invalid API key” error. See Composio's [permission route map](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions) and [permission troubleshooting](https://docs.composio.dev/kb/guide/platform-project-api-key-permissions).

These are permissions on the **Composio project key**. The Google or Slack consent screen separately controls what Otto can read or change in that account. Otto uses Composio's default app OAuth scopes unless you supply a `COMPOSIO_*_AUTH_CONFIG_ID` from `.env.example`. To narrow those grants, configure the required app scopes in that auth config and reconnect existing accounts; changing the project key does not change app consent. See [Controlling scopes](https://docs.composio.dev/docs/authentication/controlling-scopes).

Reviewed on 2026-10-02 against [`@composio/core` 0.21.0 and Otto's adapter](src/providers/composio/integrations.ts). The table covers the calls Otto makes; it has not been exercised with a newly created scoped key.

### Models

Model defaults, reviewed on 2026-09-30:

| Role                   | Model                                                                                                           | Selection                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Main agent (OpenAI)    | [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)                                        | Capability and speed for coding, browser and general assistant work  |
| Main agent (Anthropic) | [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)                             | Capability and speed when `LLM_PROVIDER=anthropic`                   |
| Event triage (OpenAI)  | [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)                                          | Short relevance decisions with reasoning disabled                    |
| Memory (main provider) | [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) on OpenAI, Claude Haiku 4.5 on Anthropic | Hourly learning, daily consolidation and meaning-based `memory_find` |

Leave `LLM_MODEL`, `TRIAGE_MODEL` and `MEMORY_MODEL` empty to follow these defaults. Memory learning and meaning-based search use the main agent's provider and key, so an OpenAI or an Anthropic key both work; `MEMORY_MODEL` picks another model from that provider. Without a key memory still saves, lints and searches by words. Explicit values override them. `TYPESAFE_API_KEY` selects Jev for triage instead. Main agents retain high reasoning effort. Restart after changing models; existing conversations use the selected model on their next turn. Model upgrades require a Pi SDK version whose catalog includes the selected model.

Ports: 4310 local app, 4330 hosted development (`node scripts/start-hosted.mjs`, see [Cloudflare](deployment/cloudflare/README.md)), 4320 E2E harness.

Ctrl-C stops the server; `docker compose stop` stops the containers. Data stays in `.local/` and Docker volumes.

## Checks

```sh
npm run check             # types, import boundaries, formatting
npm test                  # deterministic tests (database cases skip without TEST_DATABASE_URL)
npm run test:integration  # all tests in Linux with disposable PostgreSQL and Chromium
npm run build             # types and web bundle
```

The integration command builds the client and browser image, runs every test in an isolated Docker network, and removes its test containers afterward. It fails on skipped tests and does not use your local database or credentials.

Hosted deployment: [deployment/cloudflare/README.md](deployment/cloudflare/README.md). Rules for coding agents: [AGENTS.md](AGENTS.md).
