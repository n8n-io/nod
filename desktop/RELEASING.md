# Desktop releases

The current distribution target is an internal, self-signed Apple Silicon preview. The workflows prepare a version/changelog PR, require CI on the exact main revision, build a signed DMG, and verify the uploaded bytes before publishing. The app and any new runtime release stay drafts unless the workflow's publish option is enabled. Both are marked as prereleases, including the first `0.1.0` alpha. Published runtime packs are immutable and can be reused by subsequent app releases.

Self-signing does not satisfy Gatekeeper's Developer ID and notarization requirements. A new Mac may require **System Settings → Privacy & Security → Open Anyway**. Otto explains its separate Keychain prompt before accessing saved API keys. Keeping the same certificate across builds gives the app a stable signing identity; it does not guarantee that macOS will never ask for Keychain approval. See [Electron signing guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing) and [Apple distribution signing](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/).

## One-time repository configuration

Create a GitHub environment named `mac-release`. The source repository and runtime destination must remain private for self-signed previews. App releases stay in the source repository so version tags and changelog history have one authority. Runtime packs also use the source repository by default; no additional token or repository is required.

| Kind              | Name                         | Value                                                                |
| ----------------- | ---------------------------- | -------------------------------------------------------------------- |
| Secret            | `APPLE_CERTIFICATE`          | Base64-encoded PKCS#12 certificate and private key                   |
| Secret            | `APPLE_CERTIFICATE_PASSWORD` | PKCS#12 export password                                              |
| Variable          | `APPLE_SIGNING_IDENTITY`     | Exact certificate common name, for example `Otto Internal`           |
| Variable          | `APPLE_CERTIFICATE_SHA256`   | Lowercase SHA-256 of the public certificate in DER format            |
| Variable          | `OTTO_SIGNING_MODE`          | `self-signed`, also the default                                      |
| Optional variable | `OTTO_RUNTIME_REPO`          | `owner/repository` for runtime releases; defaults to this repository |
| Optional secret   | `RELEASE_TOKEN`              | Token with Contents read/write for a separate runtime repository     |

Use the existing Otto certificate from the reference project if its original PKCS#12 export is available. GitHub cannot reveal an existing secret's value. Otherwise, generate a dedicated Otto code-signing certificate in Keychain Access, export it with its private key and a password, and keep the original securely for later builds. Do not commit certificate keys or passwords. For a public DER certificate, `shasum -a 256 signing.cer` gives the required fingerprint.

Repository Actions settings must permit GitHub Actions to create pull requests. The preparation workflow explicitly dispatches CI for its bot-created release branch; the normal push/PR events are not sufficient for changes made with `GITHUB_TOKEN`.

## Release sequence

1. Merge the reviewed desktop implementation into main and let normal CI pass.
2. Run **Prepare desktop release** from main with a stable version such as `0.1.0`. It opens or updates `release/desktop`, changing only the desktop package, lockfile, release manifest, and changelog. Review the generated commit summaries and edit them into user-facing release notes as needed.
3. Merge that release PR after its CI passes. Wait for CI on the resulting exact main commit. If other source changes landed after the changelog was generated, regenerate the release PR before packaging; only the four release metadata files may differ from the recorded source.
4. Run **Build desktop release** from main. Leave **publish** disabled for the first inspection. The workflow verifies the committed version/notes, the exact successful CI revision, signing configuration, destination access, and any reusable runtime before starting Mac jobs.
5. Inspect the app and runtime drafts and complete the physical-Mac acceptance checks below. The app draft includes the DMG, checksums, public signing certificate, app/runtime metadata, and the current changelog section. Its notes link to the matching runtime draft's release page. Draft access requires repository write access. Download draft assets from their GitHub release pages or with `gh release download <tag> --repo <owner/repository>`.
6. When approved, publish the verified runtime draft first, then the app draft through GitHub. Future runs can enable **publish** to publish both previews after the uploaded runtime and downloaded DMG pass verification. The final job publishes the runtime, checks public download access when applicable, then publishes the app. Published versions are never overwritten; prepare a new version for changes. Draft runtimes are rebuilt on a new workflow run; only published runtime packs qualify for reuse.

Private runtime downloads require GitHub access. The app contains no GitHub credential: a tester downloads the matching runtime archive from the release notes and selects it in Otto's file picker. A previously verified local runtime is reused. Automatic first-launch downloading requires a public immutable runtime URL, which is reserved for the later Developer ID distribution path.

## Private-alpha installation and recovery

Testers need access to this private repository, an Apple Silicon Mac, and their own supported provider API key. Download the DMG and the exact runtime pack linked in the same release; keep the pack compressed. Copy Otto Preview to Applications before opening it. Follow macOS's Open Anyway and Keychain prompts if shown; managed Macs may require IT approval. Select the runtime pack when Otto asks. First provisioning still needs an internet connection.

Installation checks available storage against the runtime's extracted file sizes plus 512 MiB of working headroom. Automatic downloads also reserve the archive size, then check space again before extraction. Importing an archive already on disk does not reserve a second copy. The error reports the additional free space needed; free space and retry with the same matching pack. Otto keeps existing caches, conversations and settings. This check covers runtime installation, not the computer's later working storage. Minimum RAM, total working disk space and macOS 14 hardware acceptance remain unmeasured; the VM currently reserves 3–6 GiB RAM and a 24 GiB virtual disk that grows as used.

For an update, finish active work, use **Quit Otto**, replace the application and reopen it. An unchanged runtime is reused. There is no automatic updater or supported downgrade/complete backup-and-restore workflow yet. Do not delete the profile, VM, database or runtime cache as a routine recovery step. Retry interrupted setup; if it still fails, use **Copy bug report** in Chat and send it to the person who supplied the build, along with the release version and macOS version. If Chat cannot open, send the visible setup error instead. Never send API keys, passwords, or the settings file.

The runtime includes `licenses/COMPONENTS.md` and the pinned Docker CLI/Engine licenses and notices. Build preparation verifies their downloaded checksums; packaging verifies them again and includes them in the runtime's hashed file manifest. Electron/Chromium, Lima and npm dependency notices remain alongside their bundled components. The component inventory does not replace a complete redistribution review.

```mermaid
flowchart LR
  P[Version and changelog PR] --> C[Exact main CI passes]
  C --> R{Runtime inputs changed?}
  R -->|Yes| I[Linux ARM image build]
  I --> H[Mac host tools and runtime signing]
  H --> V[Upload and verify runtime draft]
  R -->|No| D[Verify existing runtime descriptor]
  V --> A[Mac app packaging and signature checks]
  D --> A
  A --> U[Upload app draft and check hashes]
  U --> Q[Download DMG and verify bytes]
  Q --> F[Draft or published preview]
```

## Build time and cost

- Ordinary CI stays on Linux. Desktop tests skip the Electron binary download and add no Mac runner to pull requests.
- Packaging runs only on manual release dispatches. It consumes successful main CI instead of rerunning the full database/browser suite on Mac.
- A runtime fingerprint covers the shared Dockerfiles, root package and lockfile, complete `src` tree, pinned downloads, runtime preparation/signing code, build dependencies, and permanent certificate identity. The root browser image copies all `src`, so changes there require a new runtime, including web source changes. Desktop shell changes and desktop version bumps reuse a published runtime when those inputs are unchanged.
- New container images build natively on Linux ARM with separate BuildKit caches. Mac runners prepare only the Mac host tools and sign/package artifacts. Lima is rebuilt from pinned source with a macOS 14 deployment target; prebuilt upstream tools are not assumed to match the app's minimum OS.
- npm, Electron downloads, verified runtime downloads, and Go compilation have separate caches. Already-compressed runtime images and DMGs use artifact compression level zero. Runtime transfer artifacts expire after one day, app artifacts after three; published release assets remain available.
- Every GitHub release asset is checked against the service's reported SHA-256 and byte count. The DMG is also downloaded again and checked. A reused runtime archive is checked through its immutable descriptor and GitHub digest; it is not repeatedly downloaded to each CI job. The app verifies its full archive and extracted files on installation.

GitHub's listed standard rates currently make Linux ARM materially cheaper than macOS; actual cost depends on the organization's plan and included minutes. No new-pipeline timing or billing result is claimed until it runs in GitHub. Sources: [runner specifications and limitations](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [release asset limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [asset digests](https://docs.github.com/en/rest/releases/assets).

## Signing and verification boundaries

The signing wrapper imports the certificate into an isolated temporary keychain, verifies its public fingerprint, identity and validity, and supplies only keychain handles and public metadata to packaging. It removes raw Apple secrets from child environments. Each signing command waits until its process group is recorded. Cleanup verifies and stops surviving groups before restoring the previous keychain search list and deleting its own temporary material, including after a failed command. It never changes the user's certificate trust settings. An `always()` workflow step provides an additional cleanup attempt.

Self-signed Electron builds retain hardened runtime but use the `disable-library-validation` entitlement: internal certificates have no Apple Team ID, so the normal library validation rejects Electron’s own framework. This exception applies only to self-signed app processes; Developer ID keeps the default Electron role entitlements. See [Apple library validation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation).

Container images and JavaScript dependencies are built before certificate secrets enter the signing step. The app is signed only after all resources and nested native binaries are in place. Runtime host binaries are separately signed; the Lima binary retains its virtualization entitlement. App, DMG, minimum OS, architecture, signature identity, and runtime descriptor checks fail the build on mismatches. A lean release does not rebuild or silently replace a published runtime.

GitHub-hosted Mac runners do not support nested virtualization. These workflows can verify native binaries and packaging, but cannot prove that Otto's private computer boots on a user's Mac. Before wider distribution, test the downloaded assets on a physical Apple Silicon Mac:

- Fresh profile: drag to Applications, handle the self-signed first-launch gate, import the runtime, enter a test provider key, complete onboarding, and verify actual workspace/browser operation.
- Upgrade: quit Otto, replace the application, reopen it, and verify existing encrypted settings, conversations, workspace and browser state remain intact. Verify the unchanged runtime is reused.
- Confirm login startup, notification text/click behavior, app quit, and explicit retry after interrupted installation.
- Exercise the oldest advertised macOS version. A binary's minimum-OS load command is a compatibility check, not a physical macOS 14 acceptance result.

Use disposable test profiles and synthetic content for automated checks. Actual model/account acceptance is a separately authorized manual check.

## Later Developer ID distribution

An Apple Developer Program account is not required for this internal preview. For public installation with Apple's normal trust checks, replace the certificate with a Developer ID Application identity and set `OTTO_SIGNING_MODE=developer-id`, `APPLE_TEAM_ID`, and the `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` secrets. Use a public runtime distribution repository. A separate runtime destination needs `RELEASE_TOKEN`. App releases currently remain in the source repository; supporting a separate public app-download repository also requires synchronizing its release tags back to the source before enabling that destination.

That path signs hardened binaries, submits the runtime host tools and application to Apple's notary service, staples the app and DMG tickets, and checks Gatekeeper assessment. Raw runtime executables have no stapled bundle ticket; their signatures and accepted notarization are verified separately. The path is implemented but cannot be accepted against Apple's service without that account and certificate. See [Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

New public runtime drafts use manual import when **publish** is disabled. With **publish** enabled, the app includes the intended public runtime URL; Mac packaging defers its anonymous download check only for the exact runtime descriptor already verified by CI. Distribute that app after the final job has published and checked the runtime. Reusing an already published public runtime keeps automatic first-launch downloading, including when the new app remains a draft.

## Reference and current evidence

The reference was [otto-grokbot-experiment](https://github.com/n8n-io/otto-grokbot-experiment) at `aa1df9901c5e0e9bb05580f417f1a02dee5be4d3`. Its internal release used a self-signed `Otto Internal` certificate. Its terminal installer verified the download and then removed quarantine from the installed app; that is separate from Apple's notarized installation flow. This pipeline does not strip quarantine or add a globally trusted certificate.

Reused ideas: a reviewable version/changelog PR, pinned actions, native ARM image builds, temporary signing keychains, cached tool downloads, cheap artifact transfer, and verification of downloaded release assets. The Electron experiment retains its own packaging and resource-signing requirements. It does not copy the reference's Tauri updater keys or multi-architecture build matrix.

Local checks and installed-app observations are recorded in [VALIDATION.md](VALIDATION.md). Hosted workflow execution and physical-Mac installation of a CI-produced self-signed release remain distinct acceptance gates.
