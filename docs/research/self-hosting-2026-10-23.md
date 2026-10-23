# Single-owner self-hosting research

Research date: 2026-10-23. Official documentation and repository inspection inform this design. This note does not establish successful account creation, deployment, model use, or message delivery.

## Product patterns

| Product                                                                                    | Useful pattern                                                                                                                                                                                                                      | Apply to nod                                                                                               |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [n8n](https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose.md) | Compose defines the whole stack, service health checks, volumes, and explicitly scoped environment values. Its [setup command](https://docs.n8n.io/deploy/host-n8n/install-options/one-line-setup.md) creates a fresh installation. | One reproducible stack, generated secrets, private backing services, and no host Node.js requirement.      |
| [Open WebUI](https://docs.openwebui.com/getting-started/quick-start/)                      | Docker is the default; a persistent data volume, fixed secret, restart policy, and update/backup links are part of the quickstart.                                                                                                  | Keep setup short and persistence visible. Retain the same key across restarts.                             |
| [AnythingLLM](https://docs.anythingllm.com/installation-docker/cloud-docker)               | The same image serves local Docker and cloud VMs; provider sizing, persistent storage, HTTPS, and templates are documented.                                                                                                         | Keep the application provider-neutral and make provider guides thin wrappers around one installation path. |

Open WebUI's [configuration reference](https://docs.openwebui.com/reference/env-configuration/) distinguishes ordinary variables from persisted settings that ignore later environment changes. nod must document precedence explicitly and verify changes survive restart. Setting an environment variable must not silently appear successful while saved state wins.

These are self-hosting comparators; their licenses and product scope differ. Their packaging is evidence for usability patterns, not evidence that nod has the same resource requirements or security properties.

## Deployment contract

- One server, one owner, one assistant. No public registration or tenant routing.
- The web app and desktop client use the same server. The desktop client stores the address and access token.
- Bind to loopback by default. A remote bind or remote public address requires a strong operator-set `NOD_AUTH_TOKEN`.
- Require HTTPS for remote `NOD_PUBLIC_URL`. Keep the token out of logs, URLs, workspace containers, and browser containers.
- Keep the access token and `NOD_VAULT_KEY` separate. Rotating access must not destroy encrypted data.
- Configure providers, channels, diagnostics, and storage at server startup. Document every exception to environment precedence.
- Persist PostgreSQL, server state, workspace files/tools, browser profiles, and TLS data. Back up configuration and Vault key with them.
- Use Docker Engine on Linux VMs and Docker Desktop on Mac. Publish AMD64 and ARM64 artifacts only after testing each architecture.
- Prefer explicit updates to unattended migration. Verify backup and restore before claiming recoverability.

## Free deployment candidates

| Provider                                                                                                           | Relevant official terms                                                                                                                                                   | Proposed use                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Google Cloud](https://docs.cloud.google.com/free/docs/free-cloud-features)                                        | US$300 for 90 days for eligible new customers; identity/payment verification; no charge unless upgraded; resources stop at expiry.                                        | AMD64 Ubuntu VM using trial credit, initially `e2-standard-2`.                                                                                      |
| [AWS Free plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)                 | US$100 on signup plus up to US$100 earned; no charges on Free plan; closes after six months or credit exhaustion.                                                         | AMD64 Ubuntu EC2; [`m7i-flex.large` is eligible](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html) under current rules. |
| [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) | Home-region allowance is 1,500 OCPU hours and 9,000 GB hours monthly, equivalent to two OCPUs and 12 GB; 200 GB boot/block storage; capacity and idle reclamation limits. | ARM64 Ubuntu `VM.Standard.A1.Flex` if capacity is available.                                                                                        |

[Azure's free account](https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account) is a fallback: US$200 for 30 days with spending protection, then an explicit paid upgrade to continue. Do not choose a paid account merely to work around trial ineligibility.

Docker supports Ubuntu on [AMD64 and ARM64](https://docs.docker.com/engine/install/ubuntu/). Ordinary Linux VMs supply a Docker host; the stack does not need nested hardware virtualization. Managed container platforms are not equivalent: nod needs persistent volumes and controlled execution in its workspace/browser containers.

For a Mac mini, Docker Desktop's [startup setting](https://docs.docker.com/desktop/settings-and-maintenance/settings/#general) starts on sign-in. Document this limit and wake/power behavior rather than promising unattended boot recovery.

## Repository gaps found

- Root `compose.yaml` starts PostgreSQL, workspace, and browser, while the application runs on the host.
- Local containers have fixed names and lack restart policies.
- Source-install docs explicitly forbid network exposure and state that restore is untested.
- Desktop docs describe only a local runtime and fresh per-device profiles.
- Configuration docs describe UI channel settings overriding environment values and omit a general server access token.

## Acceptance evidence to collect

Record the source commit, architecture, OS, Docker version, deployment configuration, and exact checks for each environment. Separate each class of evidence:

1. Deterministic integration tests: authentication, origin checks, secret boundaries, environment precedence, isolation, and channel contracts.
2. Container acceptance: fresh boot, protected API, browser execution, workspace execution, persistence, token rotation, restart, backup, and restore.
3. Hosted acceptance: real provider VM, HTTPS, remote web access, desktop connection, and reboot recovery.
4. Live account acceptance: owner-authorized Telegram/WhatsApp delivery and model use. Synthetic tests cannot establish these.

Do not include secrets, personal accounts, server tokens, or private message content in test fixtures or committed evidence.

## Backup and restore evidence

The [backup/restore check](self-hosting-backup-restore-2026-10-23.json) ran against real PostgreSQL and named Docker volumes with synthetic data on Linux ARM64. It verified the database and four volumes, original owner IDs and permissions, saved keys, exact prior service resumption, recovery after an injected backup failure, and refusal to overwrite existing data. Every disposable container and volume was removed. This validates the operations scripts, not the nod application or a cloud deployment.
