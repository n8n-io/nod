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

## OpenClaw and Hermes: concrete hosting lessons

[OpenClaw's Docker setup](https://docs.openclaw.ai/install/docker) runs onboarding, generates its Gateway token, writes configuration, and starts Compose. Official versioned images avoid its documented 6 GB source-build requirement. A browser-equipped image removes a separate Chromium installation step. Its [VM runtime guide](https://docs.openclaw.ai/install/docker-vm-runtime) is shared by provider guides instead of duplicating installation logic.

Its [Railway guide](https://docs.openclaw.ai/install/railway) packages a Gateway and Control UI behind a generated HTTPS URL, with a token and persistent `/data` volume. It includes a read-only `doctor` check and backup/restore commands. This is a useful onboarding pattern, but not an equivalent isolation architecture: OpenClaw's Docker documentation says agent sandboxing is off by default. nod must retain its separate browser/workspace containers and server-only provider secrets.

[Hermes's installer](https://hermes-agent.nousresearch.com/docs/getting-started/installation) prepares dependencies and runs setup. Its [official Docker path](https://hermes-agent.nousresearch.com/docs/user-guide/docker) offers tested AMD64/ARM64 images, a one-time setup wizard, and one persistent data directory. Pulling and recreating the container preserves data; config migrations make backups before modifying configuration. The [updater](https://hermes-agent.nousresearch.com/docs/getting-started/updating) adds pre-update snapshots or full backups, while machine migration uses explicit backup/import commands.

Hermes also has a dedicated [desktop Gateways page](https://hermes-agent.nousresearch.com/docs/user-guide/desktop) for remote connections and OS-protected tokens. The Railway templates found during this research are community wrappers, such as [this dashboard template](https://github.com/mazshakibaii/hermes-agent-railway); they should not be described as an upstream Hermes deployment guarantee.

Apply these patterns in this order:

1. Ship tested images so installation does not compile the application or browser tools on a small VPS.
2. Make one installation command generate secrets, start the complete stack, wait for health, and explain how to open the protected web app.
3. Keep provider pages focused on VM creation, firewall, and access; reuse one stack and one operations guide.
4. Keep updates and backups explicit, preserve keys and data, and validate browser/workspace execution separately from HTTP health.

## Smaller providers and free validation

The current focus is Hetzner, DigitalOcean, and Railway. Oracle provisioning is no longer being pursued. Existing AWS work can provide an independent conventional-VM environment.

| Provider                                                                      | Verified official terms                                                                                                                                                                                                                                                               | Fit for nod                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Hetzner](https://docs.hetzner.com/cloud/general/faq/)                        | Its referral-credit program has been discontinued. Allocated servers are [billed even while powered off](https://docs.hetzner.com/cloud/billing/faq/).                                                                                                                                | A suitable persistent Docker VPS when paid hosting is wanted. It does not meet the current free-only deployment constraint.                                                                                                                          |
| [DigitalOcean](https://docs.digitalocean.com/platform/billing/signup-credit/) | First-team signup credit is US$5 for 90 days, verified by the provider on 2026-07-15. A valid payment method is required before creating a Droplet.                                                                                                                                   | A short credit-funded Ubuntu VM check if the account is eligible. Confirm credit and delete resources before exhaustion; do not repeat the obsolete US$200 standard offer.                                                                           |
| [Railway anonymous VM](https://railway.com/free-vm)                           | No account/card; two vCPUs and 2 GB RAM; 60-minute build window; 24 hours to claim; preview initially restricted to the creator's IP; unclaimed files deleted. The [trial reference](https://docs.railway.com/pricing/free-trial) also limits creation to three boxes per IP per day. | A bounded experiment if capacity, Docker, and disk are sufficient. The anonymous documentation does not guarantee a disk size or Docker installation.                                                                                                |
| [Railway Sandboxes](https://docs.railway.com/sandboxes)                       | Docker daemon/CLI are [included](https://railway.com/changelog/2026-06-12-docker-in-sandboxes). Free/Trial maximum is two vCPUs and 2 GB RAM, with up to five idle minutes before destruction. Only paid plans can disable idle destruction.                                          | The right Railway product to evaluate for our Docker-based runtime. Ordinary service deployment alone does not provide nod's full stack. Active sessions can defer sandbox idle destruction; they do not extend the separate anonymous build window. |

Railway Sandboxes can join a private network and publish HTTPS domains. Their disk checkpoints preserve files but do not establish database consistency. Losing or destroying the VM loses its live Docker volumes; export a nod backup independently. A successful short sandbox test would not prove unattended hosting or reboot recovery.

On 2026-10-23, the actual anonymous Railway connection attempt was refused with “Anonymous trials are unavailable right now. Sign up to keep building.” No VM was provisioned and no nod deployment was verified through that attempt. Google OAuth signup also returned `GOOGLE_CONNECTION_FAILED` while Railway displayed an outage banner. Provider testing was paused; these are availability and signup results, not compatibility failures.

[Fly's free trial](https://fly.io/docs/about/free-trial/) allows two aggregate VM hours or seven days, up to 4 GB per VM and 20 GB volume storage, but stops trial machines after five minutes. Adding a payment card ends the trial. These restrictions make it a poor primary validation target for this stack.

[Google Cloud](https://docs.cloud.google.com/free/docs/free-cloud-features) and [AWS Free plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html) remain alternatives for eligible existing trial accounts. Do not upgrade to a paid plan to bypass a trial restriction.

Docker supports Ubuntu on [AMD64 and ARM64](https://docs.docker.com/engine/install/ubuntu/). Ordinary Linux VMs supply the Docker host needed by the stack. Managed container services need a separate compatibility assessment: nod requires a daemon, controlled container execution, PostgreSQL, and persistent volumes.

For a Mac mini, Docker Desktop's [startup setting](https://docs.docker.com/desktop/settings-and-maintenance/settings/#general) starts on sign-in. Document this limit and wake/power behavior rather than promising unattended boot recovery.

## Private prebuilt installation

The source repository is private. The implementation packages architecture-specific bundles with the server, browser and workspace images, operations scripts, source revision, image identities and SHA-256 checksums. The installer verifies these, creates or preserves private configuration, and starts Compose without compiling. Public helper images remain pinned by digest.

[The first successful private workflow](https://github.com/n8n-io/nod/actions/runs/40009648836) built and tested both Linux architectures natively and uploaded their bundles. These are private CI artifacts, not public releases. Authorized operators download them to their own computer and transfer them through SSH; the server needs no GitHub credential. Artifact checksums detect corruption; source authenticity comes from selecting the authenticated workflow and checking its revision.

The [environment evidence](self-hosting-environments-2026-10-23.json) records the exact tested revisions, local ARM64 bundle acceptance, AWS AMD64 stack acceptance, and remaining limits. Later fixes need their own validation; this evidence does not claim final-head or public-release readiness.

A later registry path can use versioned AMD64/ARM64 images pinned by digest. [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) supports anonymous pulls for public packages; private pulls require package access and authentication. Public package visibility must be an explicit release decision, not inferred from a successful private build.

## Initial repository gaps

These describe the baseline before the self-hosting implementation, not its current delivery status.

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
