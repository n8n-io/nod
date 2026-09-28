# E2B computers

The hosted E2B adapter assigns one private sandbox to each authenticated owner. Its browser, workspace, and connected CLI share that sandbox under separate Linux users: `otto-browser` (UID 1001) owns the browser, `node` (UID 1000) runs ordinary workspace commands, and `otto-connected` (UID and GID 1002) runs one Vault-backed CLI command at a time from its private directory. The server holds the E2B key, selects the template and chooses the execution user. Users do not choose providers or receive sandbox credentials.

The browser uses the existing Chromium/Xvfb worker and `/data/control.sock`. Its home and profile root are mode 0700; the socket and Xauthority files are mode 0600. App source and helpers are root-owned. Workspace files live under `/workspace`, with user-installed tools under `/home/node/.local`. Credential input, masked frames, supervised process-group cancellation and bounded artifact reads retain the existing adapter protocols.

## Build and local validation

Use Node 24.21 or later, Docker, and `npm ci`. The builder uses E2B SDK 2.51.0. Check the exact bounded context without loading credentials:

```sh
node --import tsx deployment/e2b/build.ts computer --check
node --import tsx --test tests/e2b-templates.test.ts
```

The context contains package manifests, the browser worker/bridge/readiness import closure, the generated Python workspace supervisor and the root-only computer guard. It excludes server/runtime/UI code, environment files and user data. Symlinks, unapproved imports and oversized source fail before any upload. Preflight prints only source paths, sizes and hashes and removes its temporary context.

Build the same combined image locally, then pass the returned image tag to the boundary fixture:

```sh
node --import tsx deployment/e2b/build-local.ts
node deployment/e2b/validate-computer.mjs otto-e2b-computer:<source-hash-prefix>
```

The build downloads public Docker, Debian and npm dependencies; it does not forward application environment variables into Docker. The fixture creates only its own temporary Docker container, with NET_ADMIN as the only added capability, no host network or bind mounts, and synthetic files. It checks real Chromium CDP and authenticated Xvfb access as the browser user; workspace and connected CLI denial of CDP, IPv4/IPv6 loopback, the container's own address, synthetic metadata addresses, the control port, browser files/socket, process access, helper writes and privilege escalation. Workspace DNS, HTTPS and ordinary file writes must still work. Missing NET_ADMIN and a changed firewall must fail readiness. The fixture removes only its own container. These checks do not prove the live E2B kernel, networking or pause/resume behavior.

On 2026-09-27, the combined linux/amd64 image passed that local fixture, including the positive browser and workspace checks, six denied network targets, eight denied file/process operations, and both readiness failures. The six template/readiness tests and TypeScript check also passed. On 2026-09-28, the local combined image was rebuilt with the connected CLI user. The boundary fixture passed six network and eight private file/process denials for both ordinary workspace and connected CLI users. No live E2B template or sandbox was created for this evidence.

After confirming the development key's project, build a versioned template explicitly:

```sh
node --env-file=.local/cloud/development.env --import tsx deployment/e2b/build.ts computer otto-computer-development-v1
```

This contacts E2B and creates billable provider resources according to the project's plan. Requests have a 30-second timeout; the whole build wait is bounded to 30 minutes. A timeout can leave a build running: inspect its existing state before retrying. Store the returned `templateId` as `E2B_COMPUTER_TEMPLATE`, with `COMPUTER_PROVIDER=e2b`, in that development configuration. Build production separately using its own project key and versioned name. Never substitute development keys or allocations for production. The template has two virtual CPUs and 3 GiB memory. Old `browser` and `workspace` build targets remain for legacy fixtures; the combined hosted configuration rejects their old template environment keys and does not adopt their allocations.

## Startup and isolation gate

`computer-guard.py start` runs as root, installs a dedicated nftables `inet` OUTPUT chain, records its exact accepted rules, then drops groups and switches to `otto-browser` before starting the browser worker. The rules match workspace UID 1000 and connected CLI UID 1002 across IPv4 and IPv6. They reject local interface addresses, loopback, private/link-local/metadata networks and TCP port 49983. Only DNS on port 53 to the sandbox's configured resolvers is exempted before those denies. Browser traffic uses its existing trusted browser policy.

The image removes setuid/setgid bits and file capabilities and contains no sudo. Workspace execution additionally uses `setpriv --no-new-privs`. The workspace cannot change root-owned files or firewall rules. Public sandbox traffic is disabled separately by the SDK; that setting alone does not isolate processes inside a sandbox.

Before making a created or resumed sandbox available, the trusted client runs this fixed command as root:

```sh
python3 /opt/otto/computer-guard.py check
```

Only exit zero, exactly `{"ready":true}` plus a newline, and empty stderr establish readiness. The check verifies private/root-owned paths, current interface/resolver inputs, unchanged firewall rules and an actual browser-worker socket exchange as the browser user. It does not reinstall a lost firewall, restart a missing browser, clear an uncertainty fence or adopt another resource. A filesystem-only provider resume may lose processes and network rules; that case must fail readiness.

The E2B runtime's published default kernel configuration enables nftables and `NFT_META`, while legacy `NETFILTER_XT_MATCH_OWNER` is disabled. This is why the guard uses native nftables `meta skuid`. Published source is not proof of the deployed project's guest capabilities: a live development build must verify NET_ADMIN, the complete deny matrix, DNS/Internet and pause/resume before enabling the template in production. Missing support is a blocker; never skip the guard. E2B's in-VM `envd` exposes process/file control on port 49983, which must remain unreachable by workspace commands. Sources checked 2026-09-27: [E2B runtime architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md), [default kernel selection](https://github.com/e2b-dev/runtime/blob/main/packages/shared/pkg/featureflags/flags.go), [kernel configuration](https://github.com/e2b-dev/runtime/blob/main/firecracker/fc-kernels/configs/x86_64/6.1.158.config).

## Ownership, recovery and acceptance

The durable allocation store binds owner, resource, generation and version. Shared browser/workspace activity must use that single allocation's lease and active-command accounting. A lost heartbeat, interrupted transport, failed readiness check or missing terminal acknowledgement fences the allocation. Never create a replacement, adopt an expired lease or clear uncertainty merely to make a retry succeed.

Normal shutdown drains accepted commands and closes the browser namespace before confirming pause and releasing ownership. Reconnect must retain the same sandbox ID and generation. Idle pause and continuous-runtime recycling must wait for both browser and workspace commands. SDK creation disables traffic auto-resume and selects pause on timeout. Provider disk or memory snapshots do not replace owned transcript/artifact storage. Operators still need retention, deletion and explicit uncertain-resource recovery procedures. [E2B persistence reference](https://docs.e2b.dev/sandbox/persistence).

Local fixtures and image checks establish only their tested boundaries. Live development acceptance must verify one sandbox ID across browser and shell, the full isolation matrix, synthetic navigation and private input, cancellation with a surviving child, artifact publication, same-resource pause/resume and profile recovery after an actor restart. A readiness or receipt failure must remain fenced without replay. Only then repeat the approved journey with production keys. Keep sandbox IDs, credentials, private frames and user content out of public reports.

## Opt-in disposable development acceptance

`acceptance.ts` supplies a live provider test, separate from the Docker validator. It never runs by default or in CI. The ordinary Node tests execute its injected lifecycle/transport fixtures and the Python probe's offline regressions; they need no E2B credentials and create no provider resources.

Before live use, review the selected development project's key and the combined template ID in its dashboard. Put only the approved development configuration in an owner-only environment file with `OTTO_ENVIRONMENT=development`, `COMPUTER_PROVIDER=e2b`, `E2B_API_KEY` and `E2B_COMPUTER_TEMPLATE`. Use the actual template ID returned by its build. Environment labels cannot authenticate which project issued a key: the operator must verify this pairing. Production keys, ordinary users' sandboxes and old allocations are outside this harness's scope. Do not pass service credentials through shell arguments or upload environment files.

Create a new private journal under the ignored `.local/cloud` directory. `plan` is offline; it binds the template, a credential fingerprint, exact source hashes, a random synthetic owner/task and a disposable-resource nonce. Source binding follows the bounded relative-import closure of the harness, host adapters and guest entrypoints, including template preparation, Python helpers and the package lock; linked or out-of-root sources are refused. Review `plan.json` before copying its printed hash into the explicit live command. The plan expires for execution after 24 hours. All commands require a Unix host, Node 24.21 or later, and the same canonical directory and source; files use mode 0600 and directories mode 0700.

```sh
node --import tsx deployment/e2b/acceptance.ts plan --env <private-development-env> --journal .local/cloud/e2b-live-development-1
node --import tsx deployment/e2b/acceptance.ts run --env <private-development-env> --journal .local/cloud/e2b-live-development-1 --confirm-plan <reviewed-hash> --development-only
```

`run` makes one sandbox creation attempt with SDK control-plane retries disabled, which can incur provider usage. It saves and fsyncs the intent before creation and its returned resource ID before readiness or tool calls. It uses the existing E2B client, allocation manager, browser bridge and supervised workspace. Both capabilities share the same synthetic owner's allocation. The checks cover:

- The fixed guest readiness gate, actual root NET_ADMIN/nftables support, browser CDP and authenticated X11 positives before and after workspace denial, and workspace denial of browser files/profile/socket, synthetic browser process environment, root-owned helpers and privilege escalation.
- Positive browser listeners followed by workspace rejection on IPv4/IPv6 loopback and every configured non-loopback address. The real envd port 49983 is checked with TCP connections only; no control API is invoked. No interfaces, metadata addresses or firewall rules are changed. An absent non-loopback IPv6 interface is recorded as zero checks; IPv6 loopback remains required. Public DNS/HTTPS and ordinary workspace writes must work.
- Example Domain navigation, exclusive creation and bounded artifact-byte reads of a synthetic CSV, held-browser pause refusal without a provider pause attempt, and acknowledged cancellation of a TERM-resistant child process.
- A synthetic persistent cookie on `https://httpbin.org`, same-resource pause/resume, and a fresh adapter instance reconnecting to the same allocation generation and reading the original file/cookie without reseeding them. The final successful state is confirmed paused with the allocation lease released.

The guest probe has a 100-second work budget plus 20 seconds for its own descendants and files to be cleaned up; the remote command has a 150-second bound. Cleanup cannot pass while the probe's display lock or socket remains. Individual SDK requests, browser commands and supervised commands retain their existing deadlines. The CLI exits after 15 minutes at most, including failed operations with lingering provider streams. Fixed aggregate results and command start/terminal receipts are recorded privately; raw browser pages, command output, cookies and credentials are not logged. A timeout, failed readiness, uncertain transport or missing receipt stops the run. The run cannot be repeated in the same journal, even after failure. No automatic reconnect, replacement, deletion or action replay is used as failure recovery.

Inspect the exact resource separately. If creation lost its response before recording an ID, inspection searches only the plan's unique disposable metadata and template; zero or multiple matches establish no resource to act upon. A uniquely matched resource may be deleted by the separate cleanup command, never adopted to continue a failed test.

```sh
node --import tsx deployment/e2b/acceptance.ts inspect --env <private-development-env> --journal .local/cloud/e2b-live-development-1 --confirm-plan <reviewed-hash> --development-only
node --import tsx deployment/e2b/acceptance.ts cleanup --env <private-development-env> --journal .local/cloud/e2b-live-development-1 --confirm-plan <reviewed-hash> --development-only
```

Cleanup rechecks the exact template, owner, generation and disposable nonce, journals one deletion attempt, and requires a separate not-found read afterward. Its authorization applies only to this synthetic disposable sandbox; it is not normal application disposal. A lost delete response does not permit another deletion attempt: use inspection to reconcile absence. External process termination can leave `operation.lock` or an incomplete event; preserve the journal and verify that its recorded process is gone before any manual reconciliation. Never delete application allocation rows, existing recovery state, or the whole `.local` directory. Keep the reviewed source until cleanup is confirmed, because a source mismatch deliberately blocks subsequent commands.

A passing run is adapter/provider evidence only. It does not exercise Google signup, authenticated onboarding, production keys, the real SQL allocation store, a real tenant-process restart, HTTP artifact publication, bilateral account access, arbitrary website sessions, manual sign-in, deliberately broken-firewall recovery or Cloudflare deployment. The provider pause/resume and adapter reconstruction are explicit; natural idle recycling is a separate check. Complete those application and two-account checks with development accounts before any production conversion. Public HTTP dependencies can fail independently; such a failure is recorded as incomplete acceptance, never bypassed or silently retried.

Offline checks:

```sh
node --import tsx --test tests/e2b-live-acceptance.test.ts
```
