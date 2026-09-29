# Local development

Use Node.js 24.21.0 or newer and Docker Desktop. From the repository root:

```sh
npm run dev
```

The launcher installs missing dependencies, creates `.env`, starts PostgreSQL, the Linux workspace and the trusted browser container, then serves [localhost:4310](http://localhost:4310). The first run builds and downloads images. Chromium and its desktop tools are installed only in `Dockerfile.browser`; no host Chrome install or launch is required. Provider setup is in [README](../README.md), [Composio](composio.md), [channels](channels.md), and [vault](vault.md).

Ctrl-C stops the web process. `docker compose stop` retains data. Do not use `docker compose down -v` unless you intend to remove the database, installed-tool and browser-data volumes. Existing host browser profiles are not migrated. Never reset another project or the normal local profile to run a test.

The launcher prepares PostgreSQL before browser/workspace services. It generates `OTTO_POSTGRES_PASSWORD` only when absent, saves it with the matching local `DATABASE_URL` in private `.env`, starts PostgreSQL, updates only the `otto` role password through local psql stdin, verifies authentication, then starts the remaining services. Repeating startup retains the generated password. If rotation fails, startup stops before the app starts; retrying can repair the role through the same Unix-socket path. Existing tables and rows are not reset. An explicitly configured external server database is preserved. The launcher removes the old network-guard orphan after recreating services.

## Hosted mode on your computer

Keep hosted development data separate from production. A fresh-signup recording can use an explicitly authorized [environment reset](environment-reset.md); conversation reset preserves accounts and historical data. Automated tests should continue using disposable schemas and synthetic accounts instead of resetting a normal profile or production.

The selected hosted architecture as of **2026-09-28** uses Cloudflare Containers for the gateway, per-owner tenant runtimes and separate browser/workspace roles. These are separate containers, not one physical VM per user. Computer roles start lazily on first use, without allocation during signup. Hosted development defaults to the local Wrangler/Docker/R2 version of this path. E2B remains an optional, deferred provider whose live execution is unverified.

Hosted development uses real Google login, account isolation and per-user runtimes, with the web app at [localhost:4330](http://localhost:4330). It is separate from ordinary local mode on port 4310, the synthetic E2E harness on port 4320, the design prototype on port 4318 and the UI fixture on port 4346. Node.js 24.21.0 or newer is required. Install dependencies with `npm ci` first.

Create a private `.env.hosted.local` in the repository root, or keep it elsewhere and pass `--env /absolute/path/to/file`. The launcher reads only that file; it does not fall back to `.env` or inherit provider credentials from the shell. `COMPUTER_PROVIDER` chooses the launch path:

| Provider               | Local execution                                                                                           | Requirements                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare` (default) | Wrangler Worker, gateway/tenant containers, separate browser/workspace containers and local R2 emulation  | Running Docker engine, built web assets and installed Cloudflare package dependencies; no Cloudflare account or E2B key for local execution |
| `e2b` (optional)       | Loopback Node gateway, private tenant child processes and PostgreSQL object storage; computers run on E2B | Development E2B key and one combined `E2B_COMPUTER_TEMPLATE`                                                                                |

Neither path deploys, creates a tunnel or configures provider webhooks. Cloudflare uses `scripts/start-cloudflare-local.mjs` automatically; do not launch it separately. Generated configuration and an owner-only temporary `GATEWAY_ENV` file live under `.local/cloudflare-development`; the secret file is removed on normal shutdown. Local emulator state and all private environment files must remain ignored.

Run only one Wrangler container stack at a time when images are shared. Wrangler 4.141 removes containers by Docker image ancestry on exit and rebuild, without restricting cleanup to its Worker name. Different ports, container names or image tags do not isolate identical images: a second probe built with only `FROM` the active app image can remove the app's gateway and tenant containers when it exits. Stop the main stack before such probes, preserve its emulator state, and let one operator own restarts. Name-scoped manual cleanup does not prevent Wrangler's automatic cleanup.

Container startup has a 40-second overall deadline for gateway/tenant runtimes and 45 seconds for computers. The SDK receives a retry budget twice that deadline so the caller aborts before Containers SDK 0.3.7 exhausts its default eight-second instance budget and waits indefinitely for an existing process to exit. Timeout remains an unknown outcome: aborting the wait does not certify that native startup stopped. No stopped/clean receipt or generation replacement is allowed until the original SDK promise settles, followed by separate physical-stop confirmation. The helper does not destroy a container or clear a lifecycle fence.

Use a dedicated development PostgreSQL database. A separate Neon development branch works, as does a separate local PostgreSQL instance on port 54331. Its setup role must be able to create schemas and tenant roles; use the direct database connection for migrations and provisioning. Do not point hosted development at the ordinary local database or a production database. The launcher explicitly rejects local port 54329 and `OTTO_ENVIRONMENT=production`.

For a new local database, this optional setup creates a dedicated container and volume. Run it once from the repository root; it refuses to overwrite existing configuration files:

```sh
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.local', { recursive: true });
const password = randomBytes(32).toString('hex');
await writeFile('.local/hosted-postgres.env', `POSTGRES_USER=otto_hosted\nPOSTGRES_DB=otto_hosted\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600, flag: 'wx' });
await writeFile('.env.hosted.local', `DATABASE_URL=postgresql://otto_hosted:${password}@host.docker.internal:54331/otto_hosted\nOTTO_MASTER_KEY=${randomBytes(32).toString('base64')}\nBETTER_AUTH_SECRET=${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
JS
docker run --detach --name otto-hosted-postgres \
  --env-file .local/hosted-postgres.env \
  --publish 127.0.0.1:54331:5432 \
  --volume otto-hosted-postgres:/var/lib/postgresql \
  postgres:18-alpine
```

For the Cloudflare path, PostgreSQL must be reachable from Docker containers: the setup above uses Docker Desktop's `host.docker.internal:54331` in the private connection URL. Use `localhost:54331` instead for the optional E2B/process path. For Neon, use the dedicated development direct connection string. Generate independent random 32-byte `OTTO_MASTER_KEY` and `BETTER_AUTH_SECRET` values and retain them across restarts: replacing them does not migrate existing tenant credentials or encrypted data. Set file permissions to `600`; the launcher warns only when its owner or permissions are actually insecure.

Complete the file with your development provider configuration:

```dotenv
OTTO_ENVIRONMENT=development
COMPUTER_PROVIDER=cloudflare
OBJECT_STORAGE_PROVIDER=http
OBJECT_STORAGE_ENDPOINT=http://otto.storage/v1/objects/
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
LLM_PROVIDER=openai
OPENAI_API_KEY=
COMPOSIO_API_KEY=
COMPOSIO_WEBHOOK_SECRET=
```

The database, both server keys and Google credentials are required. The hosted launcher and environment example default to Cloudflare computers and the private HTTP/R2 storage broker. Create a Web application OAuth client with `http://localhost:4330/api/auth/callback/google` as an authorized redirect URI. This server-side OAuth flow does not require a JavaScript origin. Google login grants only account identity. New Notion and Linear connections use direct MCP OAuth; Google and Slack app connections use the development Composio project and its separate auth configurations. See [connections](connections.md) and [Composio](composio.md) for each `COMPOSIO_*_AUTH_CONFIG_ID` override.

For the optional E2B/process path, explicitly set `COMPUTER_PROVIDER=e2b` and `OBJECT_STORAGE_PROVIDER=postgres`, remove `OBJECT_STORAGE_ENDPOINT`, and add `E2B_API_KEY` and `E2B_COMPUTER_TEMPLATE`; see [template setup](../deployment/e2b/README.md). Legacy E2B split-template keys are rejected; retained browser/workspace allocation rows are preserved and block automatic migration to a new combined resource. Changing providers does not migrate existing computer files, profiles or storage, and must preserve their recovery fences.

```sh
npm run build
npm --prefix deployment/cloudflare ci
node scripts/start-hosted.mjs --check
node scripts/start-hosted.mjs
```

The build and Cloudflare install are needed only for the Cloudflare path. `--check` validates configuration without connecting to a provider or database and reports field names without values. Cloudflare serves `dist/web`; rebuild it after frontend edits. The E2B/process path uses Vite during development. Cloudflare's compact gateway configuration has a 5 KiB limit; it includes only explicitly configured values, and model/integration credentials stay outside both computer roles.

On macOS and Linux, Ctrl-C or SIGTERM asks the Cloudflare launcher to stop safely. It keeps Wrangler running while the existing signed deployment control pauses new work, lets accepted work finish, checkpoints both computer roles and confirms termination of each exact tenant generation. The drain has a five-minute deadline. Only a verified prepared receipt permits the launcher to signal Wrangler; admission remains closed across shutdown. Manual browser holds, unknown outcomes, mismatched state or timeouts leave the stack running. Repeated signals never force termination. The E2B/process launcher retains its ordinary signal shutdown, which must dispose both capabilities and acknowledge provider pause before releasing its allocation lease. Deployment drain uses reversible pause/resume and refuses active browser holds or uncertain state.

The local installation has a stable random 40-character hexadecimal identity in `.local/cloudflare-development/local-installation.json`, bound to the development database URL, environment and master key. The launcher supplies it to both runtime image builds and gateway configuration. Its health `release` value identifies this local installation, not a Git commit or deployed version. An owner-only, fsynced `local-shutdown.json` records the exact shutdown operation and prepared receipts. On the next launch, matching image health and durable state allow the same operation's abort to reopen admission only after clean-stop recovery checks. Keep these files and their matching environment configuration with the R2 emulator state; changing the database URL or master key is a migration, not a way to bypass recovery.

If a stop is refused, inspect the cause and explicitly resume the recorded operation against the still-running stack before another stop request:

```sh
node scripts/start-hosted.mjs --env /absolute/path/to/private.env --resume
```

This command starts no Wrangler process and is Cloudflare-only. It uses the existing journal and signing key; it cannot adopt another operation, replay computer actions, clear fences or repair an uncertain role. Unknown or still-running control operations retain the journal. `--check` and `--resume` cannot be combined. `launcher.lock` prevents a second launcher and `local-control.lock` excludes concurrent drain/resume operations; successful prepare retains the latter until Wrangler exits. An external kill can leave these locks behind. Preserve their contents, the journal and emulator state, verify that the recorded process and its Wrangler child are gone, and reconcile that exact lock before another launch. Never delete `.local`, journals or computer state to get past a refusal.

Stop cleanly before editing watched server/Worker sources or restarting after configuration changes. Automatic Wrangler rebuilds, Docker termination, SIGKILL and host failure bypass the launcher handshake and can still leave uncertainty fences. The control fixtures exercise signed local HTTP, private files and isolated signal groups. Actual local acceptance also verified two Google accounts with dirty browsers: SIGINT checkpointed both before stopping Wrangler, the next launch recovered the same prepared operation, and both original tasks read only their own persistent cookie in new runtime generations. This covers local Docker/R2 emulation, not deployed Cloudflare or arbitrary website sessions. See the [acceptance record](testing/results/2026-09-26-cloud-hosting.md#actual-local-launcher-shutdown-and-restart).

The launcher selects PostgreSQL private object storage for E2B/process mode and the private HTTP/R2 broker for Cloudflare. Actor-local directories are caches. Each artifact and transcript is limited to 15 MiB. Cloudflare computer checkpoints are separate archives with a 256 MiB total limit, 64 MiB per file and 20,000 entries including the root. They preserve workspace/tool files and browser profile data, not live page state. Browser holds and active native sign-in prevent idle quiescence; ordinary shutdown may close browser sessions before checkpointing. Unknown outcomes quarantine the computer instead of replaying work. Keep the local R2 emulator's state for restart tests, and development databases separate from production.

For a local privacy notice, use `OTTO_PRIVACY_NOTICE_FILE=dist/web/privacy-notice.md` with Cloudflare after building the reviewed `public/privacy-notice.md`. The E2B/process path can read `public/privacy-notice.md` directly. Do not place notice contents in the gateway environment. [Privacy setup](production.md#privacy-and-google-sign-in).

The explicit filesystem object adapter remains available for custom setups. A process crash while holding its exclusive lock leaves the object fenced until the operator confirms the old process stopped and reconciles that lock. Use PostgreSQL or the HTTP broker for automatic restart testing. Storage-provider changes require explicit byte and metadata migration, and an interrupted external action without a durable result receipt must be reconciled before resuming its task.

Authenticated onboarding calls `/api/account/prepare` on mount. With Cloudflare, preparation does not allocate browser/workspace roles; each starts on first use. If E2B is explicitly selected, preparation creates or reuses one durable owner allocation without launching model work. App connections stay available, and completion waits for provider preparation with a concise retry on failure. Tests inject provider transports; synthetic keys must never trigger real sandbox creation merely by booting a tenant.

The server configuration selects the computer provider. Hosted mode supports Cloudflare and E2B; ordinary local mode supports Docker or E2B. Users do not select providers or enter operator API keys. Model customization uses `LLM_PROVIDER`, `LLM_MODEL`, `ROUTING_MODEL` and `TRIAGE_MODEL`; set `ANTHROPIC_API_KEY` when selecting Anthropic. Missing model or integration keys leave those capabilities unavailable. `OTTO_DEVELOPER_IDS` is a comma-separated list of signed-in user UUIDs allowed to inspect the computer; ordinary users see chat, apps, channels and account settings. [Replacing modules](replacing-modules.md) describes the adapter boundaries.

`OTTO_MAX_USERS` controls the total number of provisioned users in the hosted instance. The pilot default remains 8; accepted values are 1–400. Existing users retain their accounts when admission is full. Cloudflare's checked-in limits remain one gateway, eight tenants, eight browser computers and eight workspace computers. Browser/workspace roles start only when used. Raising admission requires matching all role limits and reviewing database connections and cost.

### Receiving real webhooks locally

The optional relay listens on loopback port 4331 and forwards only `POST /api/webhooks/composio`, opaque Telegram/WhatsApp callback URLs, and WhatsApp's GET verification challenge to the gateway on 4330. It excludes login, account, chat, internal control and all other routes. It strips cookies and client identity headers and preserves the raw body and provider signature headers. The application still verifies provider authentication.

In separate terminals, start the relay and your chosen tunnel:

```sh
node scripts/webhook-relay.mjs
cloudflared tunnel --url http://127.0.0.1:4331
```

Copy the resulting HTTPS origin into `OTTO_WEBHOOK_ORIGIN` in the hosted environment file and restart the gateway. Configure the development Composio webhook destination as `<tunnel-origin>/api/webhooks/composio` with the matching development webhook secret. New hosted watches receive that deployment's callback override. When a temporary tunnel URL changes, update the origin and use the [scoped Composio repair procedure](composio.md) to read back and update each affected saved watch; changing the project destination alone does not replace existing overrides. Telegram setup through Channels uses the server-generated opaque callback URL, and its affected development callbacks must also be re-registered after a tunnel change. Google sign-in remains on localhost:4330; the tunnel exposes no login page. The launcher never starts a tunnel or rewrites saved provider callbacks automatically.

### What local checks establish

`tests/hosted-development.test.ts` verifies provider selection, launcher isolation, compact local Worker configuration and the relay allowlist with synthetic values. `gateway`, `tenant-control`, `runtime-host`, `hosted-webhooks`, `channel-account-leases` and `better-auth-session` exercise ownership, signatures, revocation, lease races and SDK database behavior with injected providers or disposable PostgreSQL. Cloudflare adapter/transport and computer-checkpoint fixtures cover separate roles, immutable generation, cancellation, archive integrity and uncertainty. They do not prove real OAuth consent, webhook registration or message delivery.

Separate actual local checks have exercised Wrangler, R2 emulation and Linux amd64 Docker images on an ARM64 host: native exec streams/exit, TERM-resistant process drain, browser navigation/screenshots, checkpoint restoration after container destruction and old-generation denial. The isolated image proof also preserved synthetic Chromium cookies/local storage. These checks used synthetic authority and disposable data, not a deployed Cloudflare account. The complete development Google/Neon/assistant journey and production acceptance remain separate in the [acceptance record](testing/results/2026-09-26-cloud-hosting.md).

The separate `scripts/hosted-ui-fixture.ts` runs the actual web app against synthetic account and integration adapters on port 4346, with no database or real provider access. Use `node --import tsx scripts/hosted-ui-fixture.ts` for repeatable login, onboarding, settings and responsive UI review. Its simulated consent route exists only in that script and is never imported by the application. The fixture connects Gmail, Google Calendar and Slack for the first account, posts the instant greeting on onboarding or on the first empty-chat landing, adds synthetic findings about six seconds later, and `/fixture/chat?state=welcome|empty` replays the landing welcome or shows an empty chat after the welcome. Its Channels page simulates the Telegram token check, a stand-in Start page at `/fixture/telegram`, the confirm and manual user ID steps, and `/fixture/telegram/expire` for an expired link. No bot is contacted. Set `OTTO_UI_ATTACHMENTS=true` to add a synthetic conversation with a generated photo, SVG diagram, ZIP file and three-page PDF, served from in-memory `/api/artifacts/<id>` routes for attachment layout review. It also serves synthetic Vault logins, one card and generated favicons from memory so Vault can be reviewed without a database; they reset when the script restarts. Real provider acceptance instead uses `start-hosted.mjs`, development accounts and actual callbacks; production verification remains a separate step.

Set `OTTO_UI_FIXTURE_DATA=plans` to sign in with onboarding complete and serve synthetic goals, schedules, run history and chat messages. In that mode each account has its own synthetic data. The fixture accepts goal and schedule PATCH requests. It answers chat requests with scripted replies after a short delay: a request that names a goal or schedule can change its time, days, progress or status, and New goal or New schedule requests add one. `GET /fixture/plans/reset` restores the synthetic data. It never runs a model.

## Code and local state

Read the relevant [area guide](../AGENTS.md), then use [architecture](architecture.md) and [API contract](api-contract.md) for cross-layer changes. Provider replacement starts in [replacing modules](replacing-modules.md). Keep provider keys in `.env` or the secure channel forms, never in React or model context.

The development sidebar Inspector button (or production More → Inspector) opens beside the current page and shows task state, safe event summaries, and browser images. It has no app keyboard shortcut. `/dev` opens it directly; `DEV_INSPECTOR=false` disables Inspector access and payload capture but keeps `/browser` and its owned control routes available. Strict taskless/tool-less conversation-routing failure metadata remains private for seven days, with fixed codes and bounded model/timing/usage fields; no prompts, outputs or raw errors are recorded by this exception. Retained images show their capture time. Failed or private capture clears ordinary pixels and disables page input; Take control remains available. Native sign-in uses a separate transient owner-only frame route; it must never enter ordinary screenshot storage or agent context.

The Inspector has Screen, Activity, Tools, Models, Costs and Prompts. Activity shows current work and execution history directly. Tools starts with recent calls; use By tool for aggregate counts and paginated calls, or Available tools for descriptions and schemas even before a task runs. Models shows assistant requests, token categories and SDK estimates. Inspecting a message narrows Activity, Tools, Models and Prompts; Show all restores owner-wide diagnostics. Filter call status or search loaded payloads, then explicitly load earlier records as needed. Data is retained for seven days, with 16 KiB per payload. Costs stays owner-wide and groups visible operation/model summaries by provider, including auxiliary model work and adapter operations for browser, integrations, speech, relevance, channels and workspace access. Only raw data and detailed metrics require expansion. Costs appear only when reported by a provider or estimated by the model SDK; unknown prices stay unavailable. Operation counts are not billable requests, and hosting billing is not connected. Existing tasks have no new recordings until they run again. Recording is best effort: a failed or slow inspector store can leave partial history and cost totals while the task continues. See [security](security.md) for capture and secret-masking limits.

The Linux workspace can install CLI packages with `npm install -g` and `pipx install`; `/home/node` persists in `workspace-tools`. Base OS packages belong in `Dockerfile.workspace`. Rebuild with `docker compose up -d --build --wait` after Dockerfile changes. The workspace must never receive provider keys, the host Docker socket, or browser profile mounts.

`Dockerfile.browser` builds the trusted browser worker with Chromium, Xvfb, xauth, xdotool and ffmpeg. It mounts only private `browser-data` and uses a fixed Docker-exec stdin/Unix-socket bridge, with no published port. Keep its process, mount and network namespaces separate from the untrusted workspace. Rebuild the image after browser worker or adapter changes; copying new host source alone does not update the running worker. Production uses `/usr/bin/chromium` for both automation and native sign-in. Fixture proxy/certificate overrides belong only in the isolated E2E worker, never in the RPC contract.

## Checks

| Command                    | Scope                                                                |
| -------------------------- | -------------------------------------------------------------------- |
| `npm run check`            | TypeScript, import boundaries, formatting                            |
| `npm test`                 | Deterministic tests; database cases skip without `TEST_DATABASE_URL` |
| `npm run test:integration` | All fixtures, including PostgreSQL                                   |
| `npm run build`            | TypeScript and web bundle                                            |
| `npm run format`           | Repository formatting; avoid broad writes during parallel work       |

Database fixtures create random schemas and their own pg-boss schema, then remove only those. The integration command runs two test files at a time to leave PostgreSQL connections available for the local app. It uses explicit `TEST_DATABASE_URL` first, otherwise the configured loopback local `DATABASE_URL`. It does not fall back to a public password or automatically select a non-local database. Set `TEST_DATABASE_URL` explicitly for a different test database.

Run focused checks while changing a boundary:

| Boundary                                      | Tests under `tests/`                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Local database setup and role migration       | `local-database`                                                                                                                                |
| App composition and replacement adapters      | `application-adapters`, `runtime-adapters`, `provider-adapters`                                                                                 |
| Task continuation, cancellation, and recovery | `task-continuation`, `task-durability`, `runtime-session`, `pi-agent`                                                                           |
| HTTP, approvals, and access                   | `access`, `server-boundaries`, `chat-api`                                                                                                       |
| Credential stages and browser recovery        | `vault`, `vault-staged`, `browser-login`, `browser-recovery`, `runtime-credentials`                                                             |
| Container browser and native desktop          | `container-browser`, `browser-desktop`, `browser-sign-in`, `browser-sign-in-handoff`, `browser-manual`                                          |
| Cloudflare computers and checkpoints          | `cloudflare-computer-adapters`, `cloudflare-computer-transport`, `computer-checkpoint`, `browser-checkpoint`; also the Cloudflare package tests |
| Google accounts and events                    | `integrations`, `provider-adapters`                                                                                                             |
| Channel verification, polling, and delivery   | `channel-settings`, `channels`, `channel-application`, `messaging-transport`                                                                    |
| Personal learning and quiet work              | `personal`, `triage-preferences`, `task-durability`                                                                                             |
| Web content, streaming, links, and audio      | `web-markdown`, `web-streams`, `message-links`, `web-speech`, `speech`                                                                          |
| Inspector catalog, private records and usage  | `inspector-redaction`, `inspector-store`, `inspector-observations`, `provider-usage`, `runtime-session`, `pi-agent`, `application-adapters`     |

Each name has a `.test.ts` suffix. For example, use the configured local database for all integration fixtures:

```sh
npm run test:integration
```

For a focused PostgreSQL file, supply `TEST_DATABASE_URL` through the environment of your test runner. Do not put real credentials in a checked-in command or shared output.

Inject fake capabilities through ports and factories for feature tests. Test vendor request/response mapping separately. Fixtures must not send real messages, access real private files, buy services, or require real keys.

## Browser and live validation

After a UI change, check the real local app at desktop and narrow widths. Include empty/loading/error states, waiting questions, expired credentials, declined approvals, and unavailable providers. Chat checks include pasted images, sanitized Markdown/HTML, history, inline reactions, typing state, screenshot attachments and public link previews. Check that ordinary observation pauses for secure input, with a separate private native sign-in view only during an owned lease.

For network changes, use a synthetic task directory to verify the user ID, capabilities, persistent CLI installs and expected HTTP and registry reachability. Browser and shell traffic have no Otto private-address, port or IPv6 deny policy; reachability follows Docker and host routing. Check the separate public link-preview fetcher against its existing private-destination rejection tests. Do not report network isolation that the default Compose bridge does not provide.

For browser changes, use a disposable browser namespace and synthetic website. Check navigation, masked captures, private native frames/input, normal sign-in shutdown and explicit continuation, cancellation and worker restart. Verify that the shell cannot read browser profiles or reach its control socket, display or debugging interface, and that no host browser process launches. Exercise password and fake-2FA continuation without real credentials. These checks establish that controlled harness only; real website security decisions and authentication require separate evidence.

Browser download acceptance runs `tests/browser-download.test.ts` and `tests/browser-download-delivery.test.ts` with a disposable `TEST_DATABASE_URL`, `OTTO_TEST_NATIVE_DOWNLOAD=true` and `OTTO_TEST_BROWSER_EXECUTABLE` pointing to Chromium. CI runs them inside the browser image with `/usr/bin/chromium`. The tests serve cookie-protected PDFs and verify exact bytes across the private browser bridge, runtime publication, owned HTTP retrieval and Telegram multipart formatting. Native opt-in fails when its prerequisites are absent; the ordinary suite explicitly skips native Chromium while retaining adapter and task-cancellation checks. Telegram delivery in this harness is a fixture, not a real recipient receipt.

Run live provider checks only within the authorized scope. Do not use reconnect/disconnect as a default repair for an SDK bug; preserve existing accounts. Record fixture evidence, live provider evidence, and unresolved steps separately in [verification](verification.md). A configured key, a mocked OAuth callback, or a synthetic login page does not prove the real service works.

`scripts/e2e-otto.ts` mounts the current `src` directory read-only in its temporary browser container. The workspace container mounts only its temporary task directory. This keeps the worker and Docker command bridge on the same protocol during acceptance checks. Set `OTTO_E2E_PORT=4341` to keep the normal app running on port 4320 during acceptance; the default test port is 4320. The override accepts integers from 1 to 65535 and applies to the listener, callbacks and manifest. It includes synthetic Telegram and WhatsApp setup through the real Channels forms and encrypted settings. Both start disconnected. The local `/e2e` operator page lists fixed fixture values; arbitrary credentials and callback URLs are rejected. The transport has no polling, accepts no incoming messages and rejects every delivery. Configured and pending-callback screens prove UI behavior only, not provider verification or delivery. `tests/e2e-harness.test.ts` checks these limits.
