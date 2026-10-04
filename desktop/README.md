# Otto desktop experiment

This experiment packages Otto as an Apple Silicon Mac application. Users open the DMG, drag **Otto Preview** to Applications, open it, and enter a provider API key. They do not install Node, pnpm, Homebrew, Docker Desktop, or PostgreSQL. The default build separates the app from a verified, reusable Otto Runtime pack to keep app downloads and updates small.

The assistant engine, database, workspace, and browser run on the Mac. Model requests still go to the selected provider and incur that provider's API charges. This is local execution with bring-your-own keys, not offline model inference.

Desktop is a wrapper around the same Otto product: it starts `src/server/index.ts`, serves the normal web build, copies dependencies installed from the root lockfile, and builds the existing `Dockerfile.browser` and `Dockerfile.workspace`. Product features stay in the shared server, providers and web code. The desktop layer supplies installation, configuration, credential storage and native window/lifecycle integration. Smaller downloads must not introduce separate product implementations or dependency versions.

## Trying it

1. Open `Otto Preview-arm64.dmg` and copy **Otto Preview** to Applications.
2. Open **Otto Preview** and choose OpenAI or Anthropic.
3. Add the provider API key and, optionally, a Composio key for app connections.
4. Choose whether to open at login and show notifications. Otto detects date/time defaults and follows the system appearance; customize these later in Settings.
5. Otto prepares its computer and browser in the background during these steps. The final step shows actual readiness and any recovery action. On a new Mac, choose the matching `Otto-Runtime-darwin-arm64-….tar.gz` when prompted. Leave the archive compressed; Otto checks and installs it automatically. An existing verified runtime is reused.
6. Open Otto. After setup, change provider keys through **Settings → Providers**, the **Otto → Settings…** menu, or **⌘,**.

**General** contains appearance, launch-at-login, and notification settings. **Preferences** contains region, clock, timezone, and quiet hours; edits made while the engine is unavailable are queued and applied when it returns. **Otto → Replay onboarding** reopens the introduction without resetting the profile or its provider keys.

Onboarding has three guided steps with Back and Continue; the Settings sidebar is available after setup. Replaying onboarding retains keys and conversations. The assistant engine starts only after setup is completed with a configured AI provider. Preparing the computer in the background does not send a model request. If notifications are enabled and setup finishes while Otto is in the background, a readiness notification brings you back without automatically focusing the app. Quiet hours still apply; normal app launches do not send readiness notifications.

This local preview has no published runtime-download endpoint. Distribute both the DMG and its matching runtime pack when trying it on a new Mac. The development Mac has a verified runtime already installed. Automatic first-launch download is implemented, but a build must include a real HTTPS release URL before that becomes the normal installation flow. Splitting the files reduces the app download; it does not remove the first installation's computer-image download or disk usage.

Closing the window keeps Otto running in the menu bar. **Quit Otto** stops its engine and private computer. Launch at login is optional. Tasks cannot run while the Mac is asleep or the app is quit.

Otto Preview uses a separate profile from the existing development installation and from `/Applications/Otto.app`. It does not import existing conversations, browser accounts, channel tokens, or connected-account identities.

## What runs locally

- Electron supplies the application shell and the Node runtime for the existing TypeScript engine.
- Lima and Apple's Virtualization framework run a private Ubuntu computer.
- The private computer contains PostgreSQL and separate workspace and browser containers. Docker is an internal implementation detail; Docker Desktop is not a prerequisite.
- Container images, the base computer image, Lima, and Docker binaries live in the versioned runtime pack. First-run provisioning may still require network access for guest system packages. The optional full build embeds these assets in the app.
- Provider keys and the Vault encryption key are encrypted through Electron `safeStorage`, backed by the macOS key store. The main app owns settings; the chat renderer cannot read saved keys.
- The engine listens on a loopback port protected by a per-launch token. Approved app windows receive access; an ordinary website or browser tab does not.
- The workspace and browser have separate networks, no host home-directory mount, no Docker socket, and no model-provider credentials.

This experiment deliberately retains PostgreSQL to exercise Otto's existing migrations, jobs, and locking. The [research and implementation plan](../docs/research/desktop-and-hosting-plan.md) recommends proving SQLite as the eventual desktop store while retaining PostgreSQL for hosted deployments. This preview does not implement that migration, organization accounts, or a SaaS service.

## Local data

Application state is under `~/Library/Application Support/Otto Desktop Experiment/profiles/local`. Private VM state is under `~/.otto-desktop-experiment/<profile identifier>`. Runtime disks, database contents, workspace files, browser profiles, Pi sessions, and encrypted settings together form the local installation's state. Copying only the database is not a complete backup.

Verified runtime versions live under `~/Library/Application Support/Otto Desktop Experiment/runtime/<release identifier>`. Installation checks the archive size and SHA-256 before extraction, accepts only the manifest's regular files, bounds expanded size, verifies every extracted file, and publishes the cache atomically. Interrupted installation can be retried. The running computer mounts this cache read-only; it does not depend on the checkout or app location. Upgrading this earlier preview requires quitting it first so its stopped computer can move from the old asset path to the cache without changing user data.

The app and DMG contain no provider keys. A local, one-time development import can populate encrypted settings from an existing environment file; only provider credentials and the optional Composio configuration are accepted. That import is not part of the normal user flow.

## Current limits

- Apple Silicon macOS only; Windows, Linux, and Intel Mac builds are planned in the research document.
- This locally built preview is ad-hoc signed. It is not notarized or ready for public distribution. A public DMG needs Apple Developer ID signing and notarization.
- macOS can request Keychain approval after the preview is re-signed. Approve that request in the OS dialog; never put the Mac password in Otto chat.
- First installation exposed an intermittent guest login-service delay; the measured first setup took about five minutes. See the [validation record](VALIDATION.md) for measured restart behavior and remaining checks.
- No automatic updates, cloud migration, multi-device synchronization, or idle-computer suspension yet.
- The first runtime installation remains large. This preview ships a companion archive until a real release-download endpoint is available; the app does not point to a placeholder URL. Old runtime versions are retained; automatic cache eviction is not implemented.
- Direct webhook delivery to a laptop is not provided. External channels that need a publicly reachable callback require a later relay or server deployment.
- The preview uses isolated test identity and data. Optional provider and integration setup still depends on the provider's API permissions and configuration.

## Release automation

The [release guide](RELEASING.md) describes the version/changelog PR, signed release workflow, required GitHub environment, runtime reuse, and acceptance gates. Internal CI previews use a stable self-signed certificate; they still require macOS first-launch approval. The installed development preview below remains ad-hoc signed.

## Building the experiment

These are developer commands, not installation steps for users. Use Node satisfying the root `package.json` engine requirement and a local Docker builder to produce the runtime images.

```sh
npm ci
npm --prefix desktop ci
npm run desktop:prepare
node desktop/scripts/runtime-pack.mjs --seed-cache
npm run build
npm run desktop:test
npm run desktop:build
```

The lean app, DMG, and matching runtime archive are emitted into `dist/desktop`. `--seed-cache` verifies and installs the prepared runtime on the development Mac, using filesystem clones where available; it is optional for distribution. Prepared assets and the generated release descriptor remain under `.local`. Runtime inputs are pinned in `desktop/runtime/downloads.json` and the generated asset manifest. The build copies the root `npm ci` installation and lockfile, including dynamic dependencies, nested packages and assets. It excludes private local files, packages incompatible with macOS arm64, and bundled Intel-only alternatives in Pi and agent-browser. It does not infer dependencies from source imports or maintain a desktop dependency list.

Runtime preparation starts a disposable browser container and verifies its control socket, public navigation, screenshot, and credential/mount boundaries before exporting the image. The check uses the same read-only filesystem and resource restrictions as the app. No provider model or connected account is called.

For a full installer that embeds the runtime assets, run:

```sh
npm --prefix desktop run build -- --full
```

That emits `Otto Preview-full-arm64.dmg`. It avoids the separate runtime pack, although first provisioning can still need network access. A lean build can enable automatic runtime acquisition by setting `OTTO_RUNTIME_RELEASE_URL` to the actual HTTPS URL of its immutable archive while running `runtime-pack.mjs`. Publish and verify that archive separately before distributing such a build. Without that variable, the picker is the supported first-install path.

## Historical distribution size

The earlier macOS arm64 build measured on 2026-10-02 uses source revision `b5cbdfda8687d6a43ba0c884a07e731535eb6ed2` with the desktop experiment changes and runtime `516ca70c945727e79b553ef9aa910b34a02f312a09de4fc451420e8a6a47b0df`. These measurements predate the switch to the full shared dependency installation and browser image. The next release must measure the resulting larger app and runtime again. That earlier DMG was approximately **84.4% smaller** than the original all-in-one preview:

| Artifact                                     |     Size |
| -------------------------------------------- | -------: |
| Previous all-in-one preview DMG (historical) |  2.52 GB |
| Earlier lean DMG                             | 392.1 MB |
| Matching runtime pack                        |  1.76 GB |
| Combined first download                      |  2.16 GB |
| App contents, excluding runtime cache and VM | 643.9 MB |

Sizes use decimal units. That DMG is exactly 392,107,107 bytes; its runtime archive is 1,759,631,260 bytes, for a combined 2,151,738,367 bytes. App contents total 643,928,109 regular-file bytes in the generated bundle. Artifact identity and hashes are recorded in `dist/desktop/release.json`; this build remains ad-hoc signed and unnotarized. App updates can reuse an unchanged runtime version. A runtime upgrade downloads its new pack separately. Splitting the download does not reduce the private computer's working disk or memory requirements.

## Development checks

To inspect the packaged engine without creating or signing an app, run `npm --prefix desktop run build -- --stage-only`. It writes `dist/desktop-staging/engine`; it does not install or launch Otto.

For an unpackaged development run, use `npm run desktop:dev` after preparing the assets and building the web UI. The native app's settings and profile persist independently of the checkout.

To replay onboarding in development, run `npm --prefix desktop start -- --onboarding`. For a fresh, isolated development profile, set `OTTO_DESKTOP_USER_DATA` to an absolute directory, for example `OTTO_DESKTOP_USER_DATA=/tmp/otto-onboarding-review npm --prefix desktop start -- --onboarding`. That override is development-only; packaged apps retain their stable profile path.
