# Security policy

Otto keeps saved logins, model keys and connected accounts, and it acts on your behalf. We take reports about it seriously and thank everyone who reports responsibly.

## Report a vulnerability

Do not open a public issue, discussion or pull request for a vulnerability.

Report it privately through [GitHub private vulnerability reporting](https://github.com/n8n-io/otto/security/advisories/new). Only Otto's maintainers and you can see the report. You can also use [n8n's Vulnerability Disclosure Program](https://n8n.io/report-a-vulnerability/); mention Otto in the report.

Please include:

- the Otto version (desktop: **Otto → About Otto**; source: `git rev-parse --short HEAD`) and how you run it (desktop app, `npm start` or `npm run dev`);
- the affected part, such as the approvals, Vault, sandbox, browser, a channel or the desktop updater;
- steps to reproduce, the impact you observed and what an attacker needs;
- a proof of concept that uses synthetic data and accounts you own.

Never send real passwords, API keys, tokens, private conversations or other people's data. Describe them instead.

## What to expect

- We aim to acknowledge your report within 3 business days.
- We aim to share a first assessment, including whether we consider it a vulnerability, within 10 business days.
- We keep you updated while we work on a fix and tell you when it ships.
- We publish a GitHub security advisory for confirmed vulnerabilities and credit you unless you prefer not to be named.

We ask you to keep the details private until a fix is released, or for 90 days after your report if that comes first. If a fix needs longer, we will explain why and agree a date with you.

## Supported versions

Otto is an early preview. Fixes go into `main` and the next desktop release. Desktop releases are cut from `main` daily and installed apps update automatically.

| Version                            | Supported |
| ---------------------------------- | --------- |
| Latest desktop release             | Yes       |
| Latest `main`                      | Yes       |
| Older desktop releases and commits | No        |

## Scope

Report anything that breaks the boundaries in [How Otto protects your data](#how-otto-protects-your-data), for example:

- getting past a server check that should have stopped or held an action, such as an approval, a read-only turn or an owner check;
- reaching the host machine, provider keys or another sandbox from the workspace or browser;
- reading saved logins, cards, model keys or another owner's data without access;
- making Otto take an action the server should have held for confirmation by putting content in front of it, such as a web page, email or file;
- reaching a local Otto server without its access key or launch token;
- making the desktop app install an update that is unsigned or not the published release;
- secrets that appear in logs, tool output, feedback reports or analytics.

These are out of scope:

- vulnerabilities in model providers, Composio, Telegram, WhatsApp or the websites Otto visits; report those to their owners;
- attacks that need an already compromised computer, or administrator access to it;
- a local server that its owner exposed to a network, contrary to the [setup guide](README.md#install-from-source);
- denial of service against your own installation through resource exhaustion;
- social engineering, phishing and physical attacks;
- missing hardening, such as a header or a version string, without a demonstrated impact;
- a vulnerable dependency without a working path through Otto. Report it upstream, and tell us if Otto is exploitable.

If you are unsure whether something is in scope, report it privately anyway.

## Research rules

Test only installations and accounts you own. Use synthetic data. Do not access or change other people's data, send messages to real recipients, or degrade services that n8n or anyone else runs. Stop and report as soon as you have shown the problem.

## How Otto protects your data

Otto is driven by a language model. Content it reads, such as web pages, emails and documents, can try to steer it. The server checks below limit what that can lead to; they do not make the model's judgment reliable. If you can make Otto do something the server should have stopped, that is a vulnerability. If Otto makes an unwise choice that the server allows, it is a bug or a design issue. Report it privately if it could put users at risk.

- **Where Otto runs.** In the desktop app and a source install, the server, database, workspace and browser run on your computer. The desktop app runs the server on your Mac and the database, workspace and browser in a private virtual machine. A hosted deployment runs them on its operator's infrastructure, with a separate runtime for each user. Model requests go to the provider you choose. Apps you connect through Composio, MCP or OAuth go to those services. Telegram and WhatsApp messages go through those services.
- **Local access.** A source install listens on `127.0.0.1` and asks for an access key once. The desktop app gives each launch its own token, and only its own windows receive it.
- **Keys and saved logins.** Model keys, the Composio key and saved logins are encrypted with a key kept in the macOS Keychain or in `OTTO_VAULT_KEY`. Hosted deployments derive a separate key for each user from the operator's master key. Provider keys never enter the workspace or the browser. To sign in to a website, Otto can read one saved login for that exact site; that login then enters the model's context and the saved conversation.
- **Workspace.** Otto's commands and file tools run in a container with no access to your home directory, no Docker socket and no provider keys.
- **Untrusted content.** Results from apps, the browser and the web reach the model marked as data, not instructions. If such content looks like an attempt to steer Otto, the server holds sends and deletions for your confirmation until your next message.
- **Approvals.** Otto's server checks connected-app actions before they run. Reads and changes to your own data run directly. Actions that reach other people, delete data or can't be classified need your confirmation, unless every recipient is someone you named or confirmed before, or a review model that sees only your recent messages matches the action to your request. Confirmed actions run once and are never retried. Actions in websites through Otto's browser depend on the model's instructions, not this check.

[AGENTS.md](AGENTS.md#safety-invariants) lists the exact rules, and [architecture](docs/architecture.md) explains how they are built.
