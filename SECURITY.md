# Security policy

nod keeps saved logins, model keys and connected accounts, and it acts on your behalf. We take reports about it seriously and thank everyone who reports responsibly.

## Report a vulnerability

Do not open a public issue, discussion or pull request for a vulnerability.

Report it privately through [GitHub private vulnerability reporting](https://github.com/n8n-io/nod/security/advisories/new). Only nod's maintainers and you can see the report. You can also use [n8n's Vulnerability Disclosure Program](https://n8n.io/report-a-vulnerability/); mention nod in the report.

Please include:

- the nod version (desktop: **nod → About nod**; source: `git rev-parse --short HEAD`) and how you run it (desktop app, `pnpm start` or `pnpm run dev`);
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

nod is an early preview. Fixes go into `main` and the next desktop release. Maintainers cut desktop releases from `main` by hand, and the app on Apple silicon Macs updates automatically.

| Version                            | Supported |
| ---------------------------------- | --------- |
| Latest desktop release             | Yes       |
| Latest `main`                      | Yes       |
| Older desktop releases and commits | No        |

## Scope

Report anything that breaks the boundaries in [How nod protects your data](#how-nod-protects-your-data), for example:

- getting past a server check that should have stopped or held an action, such as an approval, a read-only turn or an owner check;
- reaching the host machine, provider keys or another sandbox from the workspace or browser;
- reading saved logins, cards, model keys or another owner's data without access;
- making nod take an action the server should have held for confirmation by putting content in front of it, such as a web page, email or file;
- reaching a local nod server without its access key or launch token;
- making the desktop app install an update that is unsigned or not the published release;
- secrets that appear in logs, tool output, feedback reports or analytics.

These are out of scope:

- vulnerabilities in model providers, Composio, Telegram, WhatsApp or the websites nod visits; report those to their owners;
- attacks that need an already compromised computer, or administrator access to it;
- a local server that its owner exposed to a network, contrary to the [setup guide](README.md#install-from-source);
- denial of service against your own installation through resource exhaustion;
- social engineering, phishing and physical attacks;
- missing hardening, such as a header or a version string, without a demonstrated impact;
- a vulnerable dependency without a working path through nod. Report it upstream, and tell us if nod is exploitable.

If you are unsure whether something is in scope, report it privately anyway.

## Research rules

Test only installations and accounts you own. Use synthetic data. Do not access or change other people's data, send messages to real recipients, or degrade services that n8n or anyone else runs. Stop and report as soon as you have shown the problem.

## How nod protects your data

nod is driven by a language model. Content it reads, such as web pages, emails and documents, can try to steer it. The server checks below limit what that can lead to; they do not make the model's judgment reliable. If you can make nod do something the server should have stopped, that is a vulnerability. If nod makes an unwise choice that the server allows, it is a bug or a design issue. Report it privately if it could put users at risk.

- **Where nod runs.** In the desktop app and a source install, the server, database, workspace and browser run on your computer. The desktop app runs the server on your Mac and the database, workspace and browser in a private virtual machine. Model requests go to the provider you choose. Apps you connect through Composio, MCP or OAuth go to those services. Telegram and WhatsApp messages go through those services.
- **Local access.** A source install listens on `127.0.0.1` and asks for an access key once. The desktop app gives each launch its own token, and only its own windows receive it.
- **Keys.** Model keys, the Composio key and saved logins are encrypted with a key kept in the macOS Keychain, protected desktop storage or `NOD_VAULT_KEY`. Provider keys never enter the workspace or the browser.
- **Vault and sign-in.** Pi selects the account, fields and submit control. The server checks permission for the current task, selected item and exact origins. Event, read-only and onboarding turns cannot sign in. Scheduled work is checked against the instruction that created its schedule. The provider enters and submits privately, keeps observations paused during entry and submission, then, after successful submission, lets Pi inspect the live page with known values removed from text and masked in screenshots. A failed private entry keeps observation and control locked until that document changes. Vault tools return no saved password or code. The server, browser provider and destination website receive the value; a website can disclose it in a later response. A new task must pass the permission checks to keep a signed-in browser. Uses appear in Usage. See the [security model](docs/src/content/docs/trust/security-model.md) for the boundaries and limits.
- **Payments.** You approve one card, shop, checkout document, field origins, submit control, amount and currency in nod web or desktop. Approval needs the card's security code, which nod never stores. Telegram and WhatsApp cannot approve. Entry and submission use the same private document boundary. A claimed operation cannot run twice; an interrupted or failed operation is uncertain. Usage reports card submitted, and Pi checks the shop's result. Stored-card use does not enforce settlement at the issuer or establish PCI compliance. See [payments](docs/src/content/docs/trust/payments.mdx).
- **Workspace.** nod's commands and file tools run in a container with no access to your home directory, no Docker socket and no provider keys.
- **Untrusted content.** Results from apps, the browser and the web reach the model marked as data, not instructions. If such content looks like an attempt to steer nod, the server holds sends and deletions for your confirmation until your next message.
- **Approvals.** nod's server checks connected-app actions before they run. Reads and changes to your own data run directly. Actions that reach other people, delete data or can't be classified need your confirmation, unless every recipient is someone you named or confirmed before, or a review model that sees only your recent messages matches the action to your request. Confirmed actions run once and are never retried. Actions in websites through nod's browser depend on the model's instructions, not this check.

[AGENTS.md](AGENTS.md#safety-invariants) lists the exact rules, [Trust and Vault](docs/src/content/docs/trust/index.mdx) explains them for users and security teams, and [architecture](docs/src/content/docs/how-it-works/architecture.mdx) explains how they are built.
