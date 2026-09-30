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

Model defaults, reviewed on 2026-09-30:

| Role                   | Model                                                                               | Selection                                                           |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Main agent (OpenAI)    | [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)            | Capability and speed for coding, browser and general assistant work |
| Main agent (Anthropic) | [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) | Capability and speed when `LLM_PROVIDER=anthropic`                  |
| Event triage (OpenAI)  | [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)              | Short relevance decisions with reasoning disabled                   |

Leave `LLM_MODEL` and `TRIAGE_MODEL` empty to follow these defaults. Explicit values override them. `TYPESAFE_API_KEY` selects Jev for triage instead. Main agents retain high reasoning effort. Restart after changing models; existing conversations use the selected model on their next turn. Model upgrades require a Pi SDK version whose catalog includes the selected model.

Ports: 4310 local app, 4330 hosted development (`node scripts/start-hosted.mjs`, see [Cloudflare](deployment/cloudflare/README.md)), 4320 E2E harness, 4346 hosted UI fixture.

Ctrl-C stops the server; `docker compose stop` stops the containers. Data stays in `.local/` and Docker volumes.

## Checks

```sh
npm run check             # types, import boundaries, formatting
npm test                  # deterministic tests (database cases skip without TEST_DATABASE_URL)
npm run test:integration  # all tests against the local PostgreSQL
npm run build             # types and web bundle
```

Hosted deployment: [deployment/cloudflare/README.md](deployment/cloudflare/README.md). Rules for coding agents: [AGENTS.md](AGENTS.md).
