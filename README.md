# Otto

Otto is a personal assistant you use through one chat, in the Mac app, in your browser or on Telegram. It keeps one ongoing conversation with its own Linux workspace and browser, so it can research, run commands, create files, use your connected apps, run scheduled tasks and reply on Telegram or WhatsApp. Otto runs on your computer, and its model requests go to the provider you choose.

Otto is an early preview. Expect rough edges and breaking changes.

## Install

|          | [Desktop app](#install-the-desktop-app)   | [From source](#install-from-source)                                     |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Best for | Using Otto on a Mac                       | Running Otto on macOS or Linux, or changing its code                    |
| Runs on  | Mac with Apple silicon                    | macOS or Linux                                                          |
| You need | About 2.7 GB of downloads on first launch | Node.js 24.21.0 or newer, pnpm 10.34.5, Docker with Compose v2, and Git |
| Updates  | Automatic                                 | `git pull` and restart                                                  |

Either way, Otto needs a model connection: an OpenAI, Anthropic or OpenRouter API key, or a ChatGPT plan. Models don't run on your computer, and the provider bills you for use. To connect Gmail, Calendar, Slack and other apps, you also need a [Composio key](docs/composio.md).

### Install the desktop app

1. Open the [releases page](https://github.com/n8n-io/otto/releases), find the newest **Otto** release (not **Otto Runtime**) and download `Otto-arm64.dmg`.
2. Open the DMG, drag **Otto** to **Applications** and open it from there.
3. Preview builds are not notarized by Apple yet. If macOS blocks the first launch, open **System Settings → Privacy & Security** and choose **Open Anyway**. Approve the Keychain prompt if it appears, so Otto can keep its saved credentials.
4. Keep the internet connection on while Otto downloads and prepares its private computer. This takes a few minutes the first time.
5. Follow the onboarding to connect a model, answer a few questions and try a first task.

Closing the window keeps Otto in the menu bar. Scheduled tasks run only while Otto is open and the Mac is awake, so turn on launch at login in **Settings → General** if you rely on them. See [desktop app](desktop/README.md) for what runs locally, where data is stored and current limits.

### Install from source

```sh
git clone https://github.com/n8n-io/otto.git
cd otto
```

On Linux, create the settings file and a Vault key before the first start. Otto encrypts saved credentials with this key; macOS keeps it in Keychain instead.

```sh
cp .env.example .env
chmod 600 .env
sed -i.bak "s|^OTTO_VAULT_KEY=.*|OTTO_VAULT_KEY=$(openssl rand -base64 32)|" .env && rm .env.bak
```

Keep a copy of `OTTO_VAULT_KEY` somewhere safe. Saved credentials can't be read without it. Enable pnpm, then start Otto:

```sh
corepack enable
pnpm start
```

The first run installs dependencies, creates `.env`, starts PostgreSQL plus the workspace and browser containers, and builds the web app. When the server is ready it prints a link such as `http://localhost:4310/#access=…`. Open it once; your browser keeps the access cookie, so [http://localhost:4310](http://localhost:4310) works from then on. Onboarding then walks you through connecting a model, a few questions about your work and a first task.

Otto serves one owner on `127.0.0.1` with no account login. Don't expose it to a network or the internet, for example through port forwarding, a tunnel or a reverse proxy.

| To             | Do this                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop Otto      | Press Ctrl-C, then run `docker compose stop` to stop the containers.                                                                                      |
| Update Otto    | Stop it, run `git pull` and `pnpm install --frozen-lockfile`, then `pnpm start`.                                                                          |
| Get a new link | Delete `access-key` in your data folder (`.local/` by default) and restart. The key otherwise stays the same across restarts.                             |
| Find your data | `.local/` (or `OTTO_DATA_ROOT`) and the Docker volumes. The Vault key is in `.env`, or in the macOS Keychain item `dev.otto.vault` if you didn't set one. |
| Back up        | Stop Otto, then copy `.local/`, the Docker volumes and the Vault key. A tested restore procedure doesn't exist yet.                                       |

## Configure

Settings live in the ignored `.env`. `.env.example` lists the common ones. Shell variables take priority, and you need to restart after editing. The desktop app manages its own settings in **Settings**.

| Setting                        | Needed for                                                         |
| ------------------------------ | ------------------------------------------------------------------ |
| Model connection in **Models** | Chat with a key, ChatGPT plan, or OpenRouter                       |
| `COMPOSIO_API_KEY`             | Gmail, Calendar, Slack and other [Composio apps](docs/composio.md) |
| `OTTO_VAULT_KEY`               | Vault encryption on non-macOS hosts (macOS uses Keychain)          |
| `OTTO_DATA_ROOT`               | Where local data is stored (default `.local`)                      |
| `PORT`                         | The local port (default `4310`)                                    |

- **Models.** Add or switch connections in **Models** from the account menu. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` add server-managed connections. See [model connections](docs/model-connections.md).
- **Apps.** Connect apps from **Apps**. Notion and Linear use their hosted MCP servers without extra keys. See [connect apps with Composio](docs/composio.md).
- **Channels.** Set up Telegram and WhatsApp from **Channels**.
- **Usage data.** Analytics stay off until you turn on **Share usage data** in onboarding or Settings. `OTTO_ANALYTICS_ENABLED=false` turns collection off entirely. See [analytics](docs/analytics.md).
- **Feedback.** Feedback you send from the app goes to the Otto team at n8n. By default it includes a diagnostic report of your recent chat, actions and their results; you can review it or untick **Include diagnostic report** before sending.

## Troubleshooting

- **`Use Node.js 24.21.0 or newer.`** Install a newer Node.js and run `pnpm start` again.
- **Docker errors on start.** Make sure Docker is running (on a Mac, start Docker Desktop) and that `docker compose version` reports v2.
- **`Configure OTTO_VAULT_KEY…` when saving a model or key.** Set `OTTO_VAULT_KEY` as shown in [Install from source](#install-from-source) and restart.
- **Missing modules after `git pull`.** Run `pnpm install --frozen-lockfile`, then `pnpm start`.
- **The port is in use.** Set another `PORT` in `.env`.
- **The desktop app is blocked on first launch.** Use **Open Anyway** in **System Settings → Privacy & Security**.

## How Otto works

- [Architecture](docs/architecture.md): one thread per owner, turns, the workspace and browser, and hosted mode.
- [Trust and Vault](docs/trust-and-vault.md): how Otto uses private values and checks authority, for users and deployment teams.
- [Vault](docs/vault/README.md): saved logins, cards and browser sessions, private entry, permissions and limits.
- [Security policy](SECURITY.md#how-otto-protects-your-data): what stays on your computer, approvals and how to report a vulnerability.
- [Model connections](docs/model-connections.md), [skill library](docs/skill-library.md) and [analytics](docs/analytics.md).
- [Hosted deployment](deployment/cloudflare/README.md) on Cloudflare, for operators.

## Get help and contribute

- Report bugs with the [bug report form](https://github.com/n8n-io/otto/issues/new/choose).
- Ask questions and share ideas in [Discussions](https://github.com/n8n-io/otto/discussions).
- Report vulnerabilities privately, as described in the [security policy](SECURITY.md).
- Read [CONTRIBUTING](CONTRIBUTING.md) to set up development, run the checks and open a pull request. Coding agents follow [AGENTS.md](AGENTS.md).

## License

Copyright 2026 n8n GmbH. Otto uses the [Apache License 2.0](LICENSE), and [NOTICE](NOTICE) holds its attribution notice. Bundled third-party assets keep their own terms and are not covered by it: Inter uses the [SIL Open Font License](public/fonts/Inter-LICENSE.txt), the n8n Baumer fonts are [proprietary](public/fonts/Baumer-SOURCE.md), provider logos belong to [their owners](desktop/ui/logos/SOURCES.md), and the desktop runtime lists its components and their licenses in `licenses/COMPONENTS.md`.
