# Security policy

Nod keeps saved logins, model keys and connected accounts, and it acts on your behalf. We take reports about it seriously and thank everyone who reports responsibly.

## Report a vulnerability

Do not open a public issue, discussion or pull request for a vulnerability.

Report it privately through [GitHub private vulnerability reporting](https://github.com/n8n-io/nod/security/advisories/new). Only Nod's maintainers and you can see the report. You can also use [n8n's Vulnerability Disclosure Program](https://n8n.io/report-a-vulnerability/); mention Nod in the report.

Please include:

- the Nod version (desktop: **About** in the app menu; source: `git rev-parse --short HEAD`) and how you run it (desktop app, `pnpm start` or `pnpm run dev`);
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

Nod is an early preview. Fixes go into `main` and the next desktop release. Use the latest release for your platform.

| Version                            | Supported |
| ---------------------------------- | --------- |
| Latest desktop release             | Yes       |
| Latest `main`                      | Yes       |
| Older desktop releases and commits | No        |

## Scope

Report anything that breaks the boundaries in [How Nod protects your data](#how-nod-protects-your-data), for example:

- getting past a server check that should have stopped or held an action, such as an approval, a read-only turn or an owner check;
- reaching the host machine, provider keys or another sandbox from the workspace or browser;
- reading saved logins, cards, model keys or another owner's data without access;
- making Nod take an action the server should have held for confirmation by putting content in front of it, such as a web page, email or file;
- reaching a local Nod server without its access key or launch token;
- making the desktop app install an update that is unsigned or not the published release;
- secrets that appear in logs, tool output, feedback reports or analytics.

These are out of scope:

- vulnerabilities in model providers, Composio, Telegram, WhatsApp or the websites Nod visits; report those to their owners;
- attacks that need an already compromised computer, or administrator access to it;
- a local server that its owner exposed to a network, contrary to the [setup guide](docs/src/content/docs/get-started/install-from-source.mdx);
- denial of service against your own installation through resource exhaustion;
- social engineering, phishing and physical attacks;
- missing hardening, such as a header or a version string, without a demonstrated impact;
- a vulnerable dependency without a working path through Nod. Report it upstream, and tell us if Nod is exploitable.

If you are unsure whether something is in scope, report it privately anyway.

## Research rules

Test only installations and accounts you own. Use synthetic data. Do not access or change other people's data, send messages to real recipients, or degrade services that n8n or anyone else runs. Stop and report as soon as you have shown the problem.

## How Nod protects your data

Nod uses a language model. External content can affect its decisions. The server limits what the model can do. These limits do not guarantee that each decision is correct. Report a problem privately if it could put users at risk.

The [security model](docs/src/content/docs/trust/security-model.md) defines the current boundaries and limits. [Trust and Vault](docs/src/content/docs/trust/index.mdx) explains permissions and saved data. [Payments](docs/src/content/docs/trust/payments.mdx) explains card use and its limits. [Architecture](docs/src/content/docs/how-it-works/architecture.mdx) describes the system.

[AGENTS.md](AGENTS.md#safety-invariants) lists the rules for implementation changes.
