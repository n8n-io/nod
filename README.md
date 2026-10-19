<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/banner-dark.png" />
  <img alt="Otto: your assistant, with its own computer." src="docs/src/assets/banner-light.png" />
</picture>

<p align="center">
  <a href="docs/README.md"><img alt="Docs" src="https://img.shields.io/badge/docs-read_them-ff91ac?style=flat-square&labelColor=191919" /></a>
  <a href="https://github.com/n8n-io/otto/releases"><img alt="Download" src="https://img.shields.io/badge/download-macOS_·_Windows-ff91ac?style=flat-square&labelColor=191919" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache_2.0-ff91ac?style=flat-square&labelColor=191919" /></a>
  <img alt="Status" src="https://img.shields.io/badge/status-early_preview-ff91ac?style=flat-square&labelColor=191919" />
</p>

**Give Otto the task, not the steps.** It researches the web, writes files in its own Linux workspace, signs in to websites, works in Gmail, Calendar, Slack and Notion, and keeps watch on a schedule. Then it reports back in the app, on Telegram or on WhatsApp.

<table>
  <tr>
    <td width="33%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/screens/card-chat-dark.png" />
        <img alt="Otto comparing three venues in a table and drafting a booking request it hasn't sent." src="docs/src/assets/screens/card-chat-light.png" />
      </picture>
      <p><b>Give it the whole task.</b> Otto compares, decides and drafts, and doesn't send until you say so.</p>
    </td>
    <td width="33%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/screens/card-tasks-dark.png" />
        <img alt="The Tasks page with a weekday calendar check and a Friday recap scheduled." src="docs/src/assets/screens/card-tasks-light.png" />
      </picture>
      <p><b>Keep watch on a schedule.</b> Ask once in plain words. Otto checks back on its own.</p>
    </td>
    <td width="33%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/screens/card-vault-dark.png" />
        <img alt="Vault with saved logins and a card, and every use of the selected login." src="docs/src/assets/screens/card-vault-light.png" />
      </picture>
      <p><b>Sign in without sharing passwords.</b> Vault types them in privately and logs every use.</p>
    </td>
  </tr>
</table>

## Built to be trusted

- **Authority comes from you.** A web page or an email can never give Otto permission. The server checks every app action against what you asked, and asks you when it isn't sure.
- **Your secrets never reach the model.** Vault fills saved logins and cards into the exact website, privately.
- **What matters is on the record.** Every sign-in, every change or message sent through your apps, and every model cost, with a monthly spending limit.
- **Runs where you choose.** On your computer with the desktop app or from source, or hosted on the operator's infrastructure. You pick the model provider, and the code is open.

[Our trust principles](docs/src/content/docs/trust/principles.mdx) · [How Otto compares](docs/src/content/docs/trust/compare.mdx) · [Security review guide](docs/src/content/docs/trust/security-review.mdx)

## Remembers what you tell it

- **93.2% on LongMemEval**, the standard long-term memory benchmark. Asked 500 questions about months of earlier chats, Otto answered 93.2% in a fresh session that sees only the latest messages, finding the rest in its notes and its search. That's up from 79%, and among the best published memory systems.
- **No email can plant a memory.** In 216 WhisperBench attacks (108 emails, each read in the background and on request), none got a false fact or rule into Otto's memory. The same attack succeeds on OpenClaw 87.5% of the time.
- **It finds what you said.** Otto searches everything you've told it, ranks the best matches first and brings up what you said before about the topic at hand, so it can answer with the date you said it.
- **Learns only from you.** Notes come from your own words: your messages, notes you add yourself, and one style note from email you sent. Never from web pages, emails you receive or Otto's replies. See and edit every one in Settings → Memory.

[How we test memory](docs/src/content/docs/contribute/evals.mdx#benchmark-memory-with-longmemeval) · [How memory works](docs/src/content/docs/how-it-works/memory.md)

## Get Otto

**Desktop app.** Download the newest **Otto** release for Mac (Apple silicon or Intel) or Windows (preview) from the [releases page](https://github.com/n8n-io/otto/releases). See [Install the desktop app](docs/src/content/docs/get-started/install-desktop.mdx).

**From source**, on macOS or Linux with Node.js 24.21+, pnpm and Docker:

```sh
git clone https://github.com/n8n-io/otto.git && cd otto
corepack enable && pnpm start
```

You also need a model connection: an OpenAI, Anthropic or OpenRouter API key, or a ChatGPT plan. See [Install from source](docs/src/content/docs/get-started/install-from-source.mdx) for the Linux Vault key and the access link.

## Read the docs

The docs are a site in [`docs/`](docs/README.md). Run them with `pnpm --dir docs dev`, or start reading here:

| Section                                                               | What's inside                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| [Get started](docs/src/content/docs/get-started/what-is-otto.mdx)     | What Otto is, installing it and your first task       |
| [Use Otto](docs/src/content/docs/use/chat.md)                         | Chat, tasks, schedules, files, the browser and memory |
| [Trust and Vault](docs/src/content/docs/trust/index.mdx)              | Approvals, saved logins, payments and your data       |
| [How Otto works](docs/src/content/docs/how-it-works/architecture.mdx) | Threads, turns, the sandbox and hosted mode           |
| [Contribute](docs/src/content/docs/contribute/index.mdx)              | Development setup, checks, evals and writing docs     |

## Community

Report bugs with the [bug report form](https://github.com/n8n-io/otto/issues/new/choose), share ideas in [Discussions](https://github.com/n8n-io/otto/discussions), and report vulnerabilities privately through the [security policy](SECURITY.md). To contribute, read [CONTRIBUTING](CONTRIBUTING.md). Coding agents follow [AGENTS.md](AGENTS.md).

## License

Copyright 2026 n8n GmbH. Otto uses the [Apache License 2.0](LICENSE), and [NOTICE](NOTICE) holds its attribution notice. Bundled third-party assets keep their own terms and are not covered by it: Inter and Geist use the SIL Open Font License ([Inter](public/fonts/Inter-LICENSE.txt), [Geist](public/fonts/Geist-OFL.txt)), provider logos belong to [their owners](desktop/ui/logos/SOURCES.md), and the desktop runtime lists its components and their licenses in `licenses/COMPONENTS.md`.
