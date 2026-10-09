# Otto desktop experiment

This experiment packages Otto as an Apple Silicon Mac application. Users open the DMG, drag **Otto** to Applications, open it, and connect a supported provider API key or ChatGPT plan. They do not install Node, pnpm, Homebrew, Docker Desktop, or PostgreSQL. The default build separates the app from a verified, reusable Otto Runtime pack to keep app downloads and updates small.

The assistant engine, database, workspace, and browser run on the Mac. Model requests go to the selected provider using the connected API account or ChatGPT plan. Local execution still requires that model connection; models do not run offline on the Mac.

Desktop is a wrapper around the same Otto product: it starts `src/server/index.ts`, serves the normal web build, copies dependencies installed from the root lockfile, and builds the existing `Dockerfile.browser` and `Dockerfile.workspace`. Product features stay in the shared server, providers and web code. The desktop layer supplies installation, configuration, credential storage and native window/lifecycle integration. Smaller downloads must not introduce separate product implementations or dependency versions.

## Trying it

1. Download the release's `Otto-arm64.dmg` using the supplied installation link, open it, drag **Otto** to **Applications**, then open it from Applications. No GitHub account or developer tools are needed.
2. This alpha is self-signed. If macOS blocks its first launch, approve this installation in **System Settings → Privacy & Security → Open Anyway**. Approve the normal Keychain prompt if shown so Otto can use its saved credentials.
3. Choose your preferences and keep an internet connection available while Otto automatically downloads and prepares its computer and browser. An existing verified runtime is reused.
4. Connect an AI provider in the shared product onboarding: a supported API key or ChatGPT plan. Optionally add a Composio key and connect apps.
5. Use **Settings → Models** for AI connections and the Composio key. The app menu, menu bar and **⌘,** open the same Settings screen.

Alternatively, quit Otto and install the latest published release from Terminal:

```sh
(
  installer="$(mktemp)" || exit
  trap 'rm -f "$installer"' EXIT
  curl -q --proto '=https' --tlsv1.2 -fsSL https://internal.users.n8n.cloud/webhook/otto/install -o "$installer" && /bin/sh "$installer"
)
```

The installer uses stock macOS tools, verifies the release and signing identity, and installs to `/Applications/Otto.app`. Run it as your normal user with permission to install apps in `/Applications`, without `sudo`. It keeps existing keys, conversations and workspace. Open that app after installation; the same self-signed first-launch instructions apply.

Otto checks for updates after startup, every six hours while open, and after waking when a check is due. **Check for Updates…** checks immediately. Updates download automatically; choose **Later** to keep working or **Restart** to install. **Restart to update to VERSION…** remains in the menu after Later, without repeated background prompts. Restarting quits Otto like **Quit Otto** and reopens the new version. If a reply, scheduled task or background check is running, or Otto cannot check, it asks first; restarting stops it, and you can ask Otto to continue afterwards. Queued messages, schedules and connected-app checks resume after the restart. Unsent text in the message box is not kept.

**General** contains appearance, launch-at-login and notifications. **Preferences** contains region, clock, timezone and quiet hours. AI connections and model selection use the same server APIs, encrypted credential store and components as the web product; the desktop wrapper does not maintain a second AI provider selection.

The native introduction prepares the computer without requiring an AI key. Shared product onboarding offers AI connections; without one, Chat prompts the user to connect a model before the assistant can work. Preparing the computer does not send a model request. If notifications are enabled and setup finishes while Otto is in the background, a readiness notification brings you back without automatically focusing the app. Quiet hours still apply; normal app launches do not send readiness notifications. **Otto → Replay onboarding** reopens the computer introduction without resetting its profile.

First-launch downloads use the same configured release source as app updates. Private releases use the n8n download service; users do not need a GitHub account or token. Publish the matching runtime before distributing the app, because draft runtime packs are not served. Builds without a release source or an archive URL still offer manual import of the compressed matching `Otto-Runtime-darwin-arm64-….tar.gz`. Splitting the files reduces the app download; it does not remove the first installation's computer-image download or disk usage.

Closing the window keeps Otto running in the menu bar. **Quit Otto** stops its engine and private computer. Launch at login is optional. Tasks cannot run while the Mac is asleep or the app is quit.

Otto uses a fresh profile, separate from repository development and earlier desktop experiments. It does not import existing conversations, browser accounts, channel tokens, connected-account identities, or encrypted keys.

## What runs locally

- Electron supplies the application shell and the Node runtime for the existing TypeScript engine.
- Lima and Apple's Virtualization framework run a private Ubuntu computer.
- The private computer contains PostgreSQL and separate workspace and browser containers. Docker is an internal implementation detail; Docker Desktop is not a prerequisite.
- Container images, the base computer image, Lima, and Docker binaries live in the versioned runtime pack. First-run provisioning may still require network access for guest system packages. The optional full build embeds these assets in the app.
- The Composio key and Vault encryption key are encrypted through Electron `safeStorage`, backed by the macOS key store. Shared model connections use the Vault encryption key; model credentials never enter the computer containers. The settings screen reveals the Composio key only on an explicit user action.
- The engine listens on a loopback port protected by a per-launch token. Approved app windows receive access; an ordinary website or browser tab does not.
- The workspace and browser have separate networks, no host home-directory mount, no Docker socket, and no model-provider credentials.

This experiment deliberately retains PostgreSQL to exercise Otto's existing migrations, jobs, and locking. The [research and implementation plan](../docs/research/desktop-and-hosting-plan.md) recommends proving SQLite as the eventual desktop store while retaining PostgreSQL for hosted deployments. This preview does not implement that migration, organization accounts, or a SaaS service.

## Local data

Application state is under `~/Library/Application Support/Otto/profiles/local`. Private VM state is under `~/.otto-desktop/<profile identifier>`. Runtime disks, database contents, workspace files, browser profiles, Pi sessions, and encrypted settings together form the local installation's state. Copying only the database is not a complete backup.

Verified runtime versions live under `~/Library/Application Support/Otto/runtime/<release identifier>`. Installation checks the archive size and SHA-256 before extraction, accepts only the manifest's regular files, bounds expanded size, verifies every extracted file, and publishes the cache atomically. Interrupted installation can be retried. The running computer mounts this cache read-only; it does not depend on the checkout or app location.

The app and DMG contain no provider keys. A local, one-time development import can populate encrypted settings from an existing environment file; only the optional Composio key and configuration are accepted. AI connections are configured in the shared product UI. That import is not part of the normal user flow.

## Current limits

- Apple Silicon macOS only; Windows, Linux, and Intel Mac builds are planned in the research document.
- The official alpha uses the internal Otto certificate and is not Apple-notarized. Locally built development previews may be ad-hoc signed.
- macOS can request Keychain approval after the preview is re-signed. Approve that request in the OS dialog; never put the Mac password in Otto chat.
- An earlier development build exposed an intermittent guest login-service delay; that first setup took about five minutes. See the [validation record](VALIDATION.md) for dated observations and remaining checks.
- Version 0.1.2 starts with a fresh installation and profile. Later releases support automatic updates. Cloud migration, multi-device synchronization and idle-computer suspension are not implemented.
- The first runtime installation remains large and requires a network connection or manual import of its matching archive. Old runtime versions are retained; automatic cache eviction is not implemented.
- Direct webhook delivery to a laptop is not provided. External channels that need a publicly reachable callback require a later relay or server deployment.
- Optional provider and integration setup depends on the provider's API permissions and configuration.
- Official 0.1.2 prepares its runtime successfully but rejects OpenAI keys restricted from listing models. See the [dated installation result](VALIDATION.md#official-012-installation--2026-10-05); full installation and update acceptance need the corrected release.

## Release automation

Run **Release desktop** in GitHub Actions to open a version PR. After merge and successful CI, the signed Mac binary is published as a GitHub release. The [release guide](RELEASING.md) covers release notes, the required GitHub environment, runtime reuse, and acceptance checks. Internal CI previews use a stable self-signed certificate; they still require macOS first-launch approval. The historical development measurements below used ad-hoc signing.

The updater verifies the matching runtime before staging the signed application, and asks before a restart would stop running work. Private downloads use the [n8n release workflow](../deployment/n8n/README.md); its GitHub credential stays on the server.

## Building the experiment

These are developer commands, not installation steps for users. Use Node satisfying the root `package.json` engine requirement and a local Docker builder to produce the runtime images.

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm run desktop:prepare
node desktop/scripts/runtime-pack.mjs --seed-cache
pnpm run build
pnpm run desktop:test
pnpm run desktop:build
```

The lean app, DMG, and matching runtime archive are emitted into `dist/desktop`. `--seed-cache` verifies and installs the prepared runtime on the development Mac, using filesystem clones where available; it is optional for distribution. Prepared assets and the generated release descriptor remain under `.local`. Runtime inputs are pinned in `desktop/runtime/downloads.json` and the generated asset manifest. The build copies the root `pnpm install --frozen-lockfile` installation and lockfile, including dynamic dependencies, nested packages and assets. It excludes private local files, packages incompatible with macOS arm64, and bundled Intel-only alternatives in Pi and agent-browser. It does not infer dependencies from source imports or maintain a desktop dependency list.

Runtime preparation starts a disposable browser container and verifies its control socket, public navigation, screenshot, and credential/mount boundaries before exporting the image. The check uses the same read-only filesystem and resource restrictions as the app. No provider model or connected account is called.

For a full installer that embeds the runtime assets, run:

```sh
pnpm --dir desktop run build --full
```

That emits `Otto-full-arm64.dmg`. It avoids the separate runtime pack, although first provisioning can still need network access. A lean build uses `OTTO_DESKTOP_UPDATE_SOURCE_URL`, set during app packaging, for automatic first-launch downloads and updates. Alternatively, set `OTTO_RUNTIME_RELEASE_URL` to the actual HTTPS URL of its immutable archive while running `runtime-pack.mjs`. Publish and verify the matching archive before distributing the app. Without either source, the picker is the supported first-install path.

## Distribution size

Official 0.1.2 download sizes: DMG **776,431,526 bytes**, runtime **2,062,117,554 bytes**, and application update ZIP **373,271,203 bytes**. These are archive sizes, not working disk or memory requirements. Download verification is recorded in the [n8n delivery evidence](../deployment/n8n/README.md); physical installation and update acceptance are recorded separately in [VALIDATION.md](VALIDATION.md).

### Historical distribution size

The earlier macOS arm64 build measured on 2026-10-02 uses source revision `b5cbdfda8687d6a43ba0c884a07e731535eb6ed2` with the desktop experiment changes and runtime `516ca70c945727e79b553ef9aa910b34a02f312a09de4fc451420e8a6a47b0df`. These measurements predate the switch to the full shared dependency installation and browser image. That earlier DMG was approximately **84.4% smaller** than the original all-in-one preview:

| Artifact                                     |     Size |
| -------------------------------------------- | -------: |
| Previous all-in-one preview DMG (historical) |  2.52 GB |
| Earlier lean DMG                             | 392.1 MB |
| Matching runtime pack                        |  1.76 GB |
| Combined first download                      |  2.16 GB |
| App contents, excluding runtime cache and VM | 643.9 MB |

Sizes use decimal units. That DMG is exactly 392,107,107 bytes; its runtime archive is 1,759,631,260 bytes, for a combined 2,151,738,367 bytes. App contents total 643,928,109 regular-file bytes in the generated bundle. Artifact identity and hashes are recorded in `dist/desktop/release.json`; this build remains ad-hoc signed and unnotarized. App updates can reuse an unchanged runtime version. A runtime upgrade downloads its new pack separately. Splitting the download does not reduce the private computer's working disk or memory requirements.

## Development checks

To inspect the packaged engine without creating or signing an app, run `pnpm --dir desktop run build --stage-only`. It writes `dist/desktop-staging/engine`; it does not install or launch Otto.

For an unpackaged development run, use `pnpm run desktop:dev` after preparing the assets and building the web UI. The native app's settings and profile persist independently of the checkout.

To replay onboarding in development, run `pnpm --dir desktop start --onboarding`. For a fresh, isolated development profile, set `OTTO_DESKTOP_USER_DATA` to an absolute directory, for example `OTTO_DESKTOP_USER_DATA=/tmp/otto-onboarding-review pnpm --dir desktop start --onboarding`. That override is development-only; packaged apps retain their stable profile path.
