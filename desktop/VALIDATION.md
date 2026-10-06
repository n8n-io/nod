# Desktop experiment validation

## Native ChatGPT sign-in — 2026-10-06

An unpackaged Electron run of the ChatGPT sign-in changes in [PR #140](https://github.com/n8n-io/otto/pull/140) used an isolated desktop profile and Otto-managed Lima computer. Sign-in completed in the system browser with the selected ChatGPT workspace and returned automatically to Otto. Six models loaded, GPT-6 Sol was selected without opening a model picker, and the required Composio setup remained available. A real chat returned “Otto desktop sign-in verified.”

After a normal quit and restart without importing configuration again, the saved ChatGPT connection, GPT-6 Sol selection and conversation remained available. A subsequent reconnect displayed the returned email and initials avatar with the ChatGPT badge, while retaining the selection. Provider heading logos and connection-button alignment were checked in the native window. The normal installed app and its profile were preserved. This is manual native source acceptance; installation and upgrade of the resulting signed release remain separate checks. Private evidence is in `.local/chatgpt-desktop-profile` and the session's native sign-in and restart screenshots.

## Official 0.1.2 installation — 2026-10-05

The official `desktop-v0.1.2` release was built from `d62c062a639c2ef2192a5b8418105c1414afad90` after [exact-main CI](https://github.com/n8n-io/otto/actions/runs/37308477377) passed. [Build and publication](https://github.com/n8n-io/otto/actions/runs/37310113285) passed. The app and matching runtime are published prereleases, signed with the permanent Otto Internal certificate and not Apple-notarized.

The DMG downloaded anonymously through the n8n service in the browser. Its 776,431,526 bytes and SHA-256 `c4a0ff6ad16b57e75bcea044bbd938f047fc6313b1c9be5f9c114cadddefd3ca` match published metadata. Disk-image integrity, mounted and installed application signatures, source revision, version and runtime descriptor were verified. Finder copied the application to the user's Applications directory; the new Otto profile and computer directories were absent beforehand. No old profile was imported.

On this Apple Silicon Mac with 24 GiB RAM and macOS 26.6.2, Gatekeeper blocked first launch. The user approved Open Anyway; quarantine was not removed and certificate trust was not changed. Login startup and notifications were enabled through native setup. Otto automatically downloaded, verified and prepared runtime `7ac220352d6860a8342e7f072f9eb5fc26d191266dd5dadaed70665cb3828af2` in 289.981 seconds, then opened shared product onboarding. No developer command or runtime-file selection was needed. The installed runtime-cache verifier also passed.

Shared provider setup exposed a release blocker: saving the user's existing restricted OpenAI key returned a model-list access error. The shared backend rejected every non-success catalog response, losing the former narrowly scoped handling of OpenAI's sole missing `api.model.read` permission. The key was entered through the masked UI from the authorized local source; it was not logged or committed. No inference or connected-account action was made during this attempt.

This is a failed full installation acceptance, despite successful delivery and runtime preparation. Provider completion, actual browser/workspace operation, quit/reopen and a complete release-to-release update still require the corrected official release. The original 45-minute case window also elapsed while waiting for the user's Gatekeeper approval; subsequent manual observations do not retroactively pass that frozen timing gate. Physical macOS 14 compatibility remains unverified.

The shared-backend correction passed type, architecture, formatting and production-build checks, plus all **570 isolated integration tests**, with no failures, skips or cancellations. Synthetic cases cover restricted-key catalog fallback, invalid-key rejection, encrypted persistence and preservation of existing model selections after failed refreshes. Independent static review found no actionable issues. These checks do not establish successful use of the fixed official app.

Private evidence: `.local/desktop-012-validation/baseline-attempt-1.json`, `anonymous-release-delivery.json`, `openai-key-catalog-error.png` and the official release metadata. Earlier source, fixture and developer-build observations below remain separate.

## Feedback integration — 2026-10-04

The feedback branch at `90f7ef8` and desktop PR head `c8b36a1` were combined. Native provider settings, unread state, OAuth, Ask Otto, and titlebar spacing remain intact alongside the setup, memory, Telegram, Notion, PDF, and development reset changes. A missing desktop key now opens the existing Providers settings; ordinary local web setup retains `.env` guidance.

- Complete isolated integration suite: **551 passed, zero failures, skips, cancellations or TODOs** in 103.6 seconds.
- Desktop suite: **110 passed on macOS**; the remaining privileged firewall case **passed separately in isolated Linux**, with no source changes. The initial container attempts exposed missing `sysctl` and a non-executable temporary directory; the unchanged test passed after correcting that environment.
- Cloudflare fixtures: **394 passed**. Evaluation-harness fixtures: **27 passed**. Type, architecture, formatting, web build, and both Cloudflare Wrangler dry runs passed.
- Independent merge review found no actionable regression or duplicate product mechanism. Desktop continues to start the shared server and package the shared source and dependencies.

Evidence: ignored `.local/alpha-validation-2026-10-04/`. These are source and fixture checks, not fresh installation of a signed release. The packaged app intentionally ignores the development profile override; a fresh-install check requires a separate macOS login or another physical Mac to avoid the existing profile. Current release artifact and live-account acceptance remain separate gates.

## Shared product packaging — 2026-10-02

Desktop now uses the unchanged root browser and workspace Dockerfiles and the complete root npm installation. The separate browser manifest and source-import dependency scanner are removed. Runtime reuse includes the full source and root dependency lockfile; CI also builds and exercises the shared local browser image. Historical installer sizes below predate this change.

An isolated staged engine matched the source package, lockfile, server entrypoint and web entry by hash. Electron's embedded Node 24.21.0 loaded the shared server composition, Pi and the Pi web extension outside the checkout. All 12 retained Mach-O files passed ARM64 and minimum-OS checks. The staging directory was removed; no user profile or model was used. The new packaging regression loads a dynamic extension, its data file and its npm binary link after deleting the source checkout.

Type/architecture/format checks, production build and the disposable integration suite passed: **526 passes, six optional skips**. The first desktop run caught two fixture executables inheriting the newly copied root ESM package scope; their own CommonJS scope was made explicit. Both focused cases and the final desktop suite passed: **110 passes, one privileged Linux skip**. Updated-head hosted CI, full DMG/runtime packaging and installation of this revision remain separate release acceptance gates.

Evidence: `.local/desktop-shared-product-validation-checks-summary.json`, `.local/desktop-shared-product-stage.json`, `.local/desktop-shared-product-fixture-recheck.log`, and `.local/desktop-shared-product-desktop-final.log`.

## Alpha PR review — 2026-10-02

[PR #97](https://github.com/n8n-io/otto/pull/97) includes main at `60bf73ac3777252442f97b54e9b1309a388fd3f8`. Its initial hosted CI passed, including browser recovery and E2B isolation. The following review fixes passed a fresh local combined run: **526 integration passes with six optional skips**, **109 desktop passes with one privileged Linux skip**, type/architecture/format checks, and the production build. The disposable database was removed and source hashes stayed unchanged during that run. Updated-head hosted CI remains the merge gate.

Review fixes cover runtime isolation drift and cache verification, locked browser dependencies, engine-exit and deferred-restart recovery, OAuth callbacks and repeated sign-in clicks, durable preference/read-position failures, timezone defaults, and release/signing contracts. Disposable Docker checks verified retained volume contents, restored restrictions, network rejection and real browser operation; synthetic Vault/AWS environment injections were rejected. Disposable native signing verified execution and restoration of the Keychain search list. These are isolated checks, not installation of CI-produced assets.

The release environment is configured with a permanent internal self-signed identity. New app and runtime releases remain drafts unless publication is explicitly requested. Historical native observations below refer to their recorded bundles; the latest PR review changes have not yet been installed or tested on a fresh physical Mac. The first alpha is not notarized.

Evidence: `.local/desktop-pr-final-validation-checks-summary.json`, `.local/desktop-pr-followup-validation-checks-summary.json`, `.local/desktop-pr-validation-checks-summary.json`, `.local/pr97-time-zone-startup.json`, `.local/pr97-runtime-security-check.json`, `.local/pr97-browser-secrets-check.json`, `.local/otto-internal-native-result.json`, `.local/with-apple-signing-native-result.json`, and [hosted CI on `943f540`](https://github.com/n8n-io/otto/actions/runs/37047090113).

## Seamless title bar — 2026-10-02

Removed the desktop toolbar's bottom border. The title bar and sidebar already share the same theme color. The installed app was visually checked in light and dark appearance; System appearance was restored afterward. All 29 installed web files match the new build, and the original settings, preferences, owner/runtime configuration and conversation file remain unchanged. No live model request was sent.

`npm run check`, `npm run build`, deep/strict signature verification and DMG verification pass. Installed CDHash: `a563c1b399fa82f1b2154e48fa19d4c740baa61e`. DMG: **392,107,107 bytes**, SHA-256 `5e889fa882425793dda342f9408f2e9671669519d4e231c02aa4702cea19c683`. Runtime `516ca70c945727e79b553ef9aa910b34a02f312a09de4fc451420e8a6a47b0df` is reused. The previous hardening build quit normally and its VM was independently confirmed **Stopped** before this replacement; the new app reopened with its prior conversation at **17:44:40.966Z** after Keychain approval. This completes the previously pending local shutdown/reopen observation. Fresh-Mac installation of hosted release assets remains a separate gate. Evidence: `.local/desktop-evals/evidence/titlebar-installed.json`.

## Release hardening — 2026-10-02

The experiment now includes `origin/main` at `b5cbdfda8687d6a43ba0c884a07e731535eb6ed2`. The local PoC remains uncommitted; its pre-update patch and Git stash were retained. Main removed the plugins directory and the `speechReady` field, so the desktop packager and integration fixture were updated accordingly.

### Changes

- Workload firewall updates use one atomic `iptables-restore` transaction. They no longer briefly open private-network access or preserve forbidden connections established during that gap.
- Quit independently verifies that the VM stopped. Failure offers **Try again** or **Quit anyway**; cleanup remains retryable. Failed preparation also retains cleanup responsibility without hiding missing-runtime recovery.
- Provider setup checks access to the selected model through read-only metadata. It preserves the exact OpenAI restricted-key exception and previously working credentials on a rejected replacement. Metadata does not establish inference permission, available credit, or a successful model reply.
- Optional Composio and inactive provider keys can be removed through **Change → Remove → Save changes**. Cancel discards the pending removal. Active provider keys remain protected from accidental removal.
- Runtime installation checks free space before download/extraction and gives a bounded recovery message for disk exhaustion. Checks cover installation, not future VM disk growth.
- The runtime pack carries pinned Docker CLI/Engine license and notice files. Packing verifies their hashes. Existing bug reports include the desktop version, source revision, build time, and runtime identity.

### Automated and isolated evidence

- `npm run check` and `npm run build` pass. The frozen check initially found one Prettier issue after deleting an obsolete packaging root; formatting and the complete check then passed without a semantic source change.
- Integration: **529 total, 523 passed, six skipped, zero failed**, in 84.262 seconds. The disposable database was removed; no live model, connected account, or recipient was called. The previously intermittent automatic email-code case also passed 12 consecutive isolated runs; no speculative Vault change was made.
- Desktop: **88 total, 87 passed, one privileged Linux case skipped, zero failed** on macOS. The skipped case separately passed four real Linux network-namespace runs, using synthetic TCP traffic. The prior implementation reproduced the forbidden-connection race. No host firewall was changed.
- All three affected workflows pass `actionlint`. The Linux firewall check is added to existing CI; hosted Actions have not run these changes yet.
- The regenerated runtime passed browser navigation, screenshot and isolation checks. The archive verified pinned notices and rejected tampered notice input. The installed user database was not reset.
- The rebuilt app passed deep/strict ad-hoc signature verification, module/native-addon loading, and DMG verification. This is a local developer artifact, not a CI-produced self-signed release or a clean-Mac installation.

Evidence: `.local/desktop-release-hardening-frozen-checks-summary.json`, `.local/desktop-release-hardening-check-final.log`, `.local/desktop-hardening-vault-summary.json`, `.local/runtime-safety/README.md`, `.local/runtime-installation-improvements-summary.json`, and `.local/desktop-evals/evidence/provider-settings-review.json`.

### Installed upgrade

The rebuilt app is installed at `~/Applications/Otto Preview.app`. All 26 desktop shell/runtime files match the working source. Its managed VM booted and finished preparation in **31.116 seconds**. Encrypted settings, preferences, owner configuration, runtime storage configuration and the original session file remain byte-for-byte unchanged. A rollback copy is retained privately.

The user approved macOS Keychain access; the engine reached ready at **17:36:14.192Z**. Native inspection then verified Chat with the original conversation and synthetic CSV attachment, and the shared General Settings page with login startup and notifications enabled. All five previously recorded profile/session files remain byte-for-byte unchanged. The user began navigating the app during inspection, so it was left open. Installed provider Change/Cancel and a full new-code Quit/reopen check remain unrun. No new live model request was sent. Evidence: `.local/desktop-evals/evidence/release-hardening-installed.json` and `.local/desktop-release-hardening-summary.json`.

### Build and remaining release gates

Build source: `b5cbdfda8687d6a43ba0c884a07e731535eb6ed2` plus the local patch. App CDHash: `862531eff8dadbefdbe9cacceb956899d9cd6a9a`; web entry: `index-zu3JmHOV.js`. DMG: **397,872,414 bytes**, SHA-256 `23dbdcb83ef9bee3e482f2560fbff0c155443290da6710f87f8e9f31eece6147`. Runtime: `516ca70c945727e79b553ef9aa910b34a02f312a09de4fc451420e8a6a47b0df`, **1,759,631,260 bytes**. Exact metadata is in `dist/desktop/release.json` and [README](README.md).

The release environment and permanent self-signed certificate still need configuring. A hosted release build and a fresh physical Mac install of those exact downloaded assets remain acceptance gates before sharing with testers. Self-signing does not eliminate macOS Gatekeeper warnings. Windows/Linux support, SQLite migration, SaaS changes and an automatic updater are outside this hardening pass. Prior live assistant and notification receipts below retain their original revision boundaries.

## Keychain notice refinement — 2026-10-02

Installed app CDHash `bb020781b86aef9e830f251a993cbd93f1b12c78` shows the shortened Keychain notice only on the onboarding page containing **Open Otto**. Actual native inspection verified its absence on configured startup and the provider step, and its one-sentence text on the final action page. Replay was used without resetting the profile; the installation preserved settings and original session bytes. Evidence: `.local/desktop-evals/evidence/keychain-notice-installed.json` and `keychain-notice-open-otto.png`. Source check, production build and all 73 desktop tests pass. The full disposable integration run had 525 passes, five optional skips, and one failure in the unchanged automatic email-code test at `tests/vault.test.ts:2803`; the same test passed on an isolated rerun with a new disposable database. Both databases were removed. This is not a claim of a fully green integration run. Evidence: `.local/desktop-keychain-notice-final-checks-summary.json` and `.local/desktop-keychain-notice-vault-recheck-summary.json`.

## Compact onboarding and release automation — 2026-10-02

The installed local app is `~/Applications/Otto Preview.app`, CDHash `1b4095a435438abd96763300fe56460eb08d8a5a`, web `index-D4biaBAx.js`. Onboarding is now **620 × 640**; normal Settings remains **760 × 650**. Actual native provider and login/notification steps fit without clipping or scrolling. Back returns to Providers. The app is left at step one for review. Only the onboarding completion flag was reset; other settings and existing session bytes were preserved. Native screenshots: `.local/desktop-evals/evidence/compact-onboarding-providers.png` and `compact-onboarding-preferences.png`. Installation/preservation record: `compact-onboarding-installed.json` in that evidence folder.

This installed preview remains ad-hoc signed. The new release pipeline defaults to a permanent self-signed certificate and has not produced or published a GitHub release yet. The [release guide](RELEASING.md) covers environment configuration, first-launch trust limitations, runtime reuse and the physical-Mac acceptance gate.

Current source passes `npm run check`, `npm run build`, **73 desktop tests**, and the isolated integration suite (**531 total, 526 passed, five optional skips, zero failures**). The temporary database was removed and absence verified; no live provider or connected account was called. Evidence: `.local/desktop-release-final-checks-summary.json`.

Release automation verification is separate from native product acceptance:

- All three affected workflows pass `actionlint`, including shell checks.
- Version/changelog preparation passes **26 disposable real-Git CLI scenarios**, including later-source rejection and release-metadata-only merge acceptance.
- Release orchestration passes **24 actual-CLI scenarios** using real Git and synthetic GitHub responses, with network disabled: exact-source CI, version/source consistency, private self-signed destinations, runtime reuse, credential scope, corrupt assets, published-release refusal and download verification. No remote mutation occurred.
- Temporary-keychain handling passes **14 synthetic boundary cases** and a real disposable self-signed native executable test. Signature verification, execution, cleanup and restoration of the original keychain search list passed; existing user signing credentials and trust settings were not changed.
- A disposable certificate signed and verified **21 nested Mach-O files** in an actual Electron 44.5.0 app clone. Running Electron in Node mode then loaded Pi, its web extension, and its Darwin native addon. Signed Lima and Docker tools also executed. The synthetic app, private key and keychain were removed and the original keychain search list restored. This checks framework/module loading; it does not launch the UI, utility process, provider session or VM. Evidence and exact source hashes: `.local/release-validation/summary.json`.
- Pinned Lima 2.2.0 was rebuilt for macOS 14 and executed on this macOS 26 machine; the Mach-O minimum OS, architecture and version checks passed. That does not establish macOS 14 hardware or VM-boot acceptance.

Hosted Actions, a full CI image/runtime packaging run, and fresh-Mac installation of CI-produced assets remain unmeasured. No Apple Developer ID certificate or notarization service was used. Exact CLI evidence is in `.local/desktop-release-cli-results.json`, `.local/with-apple-signing-native-result.json`, and `.local/desktop-evals/evidence/prepare-release-fixture.json`.

## Earlier revision — attachment layout, 2026-10-02

Base `f187ac8911beba6d091d54b3274312c67f13ef81`; the earlier main comparison was zero ahead/behind, and this experiment remains uncommitted. Installed app: `~/Applications/Otto Preview.app`, deep/strict ad-hoc signature `d3e7779398c476d664181c8c70b208da1fb1054b`. All 148 shell/web files match source/build. Web entry: `index-D4biaBAx.js`. Runtime `88904e5a1db4527ce90791a2296bf20740b0f5450ef84fad94b02f7a0eb4e81b` is unchanged.

### User-facing changes

- Onboarding now has three guided steps: provider keys, login/notifications, and actual preparation. Date/time defaults are detected; existing preferences survive and remain editable in Settings.
- Readiness can notify an opted-in user who leaves during setup, outside quiet hours. It neither steals focus nor notifies on ordinary completed-profile startup. The authoritative user-confirmed banner and click record is in [U03.v3](evals/runs.md#u03v3--installed-readiness-notification).
- Settings has no separate title strip, uses tighter spacing, and no longer focuses its heading when changing sections. The duplicate page title in the main desktop toolbar is removed. The Chat bug-report action remains visible.
- Before saving keys or opening Otto, a macOS-only explanation identifies the Keychain password prompt and says to enter the password only in the system dialog. The same explanation appears during configured startup before decryption. The installed startup view was observed before the OS prompt; no password was read or entered by automation.
- Attachment dialogs reserve the native title-bar region. The same available height controls images, video, PDF and spreadsheet previews; browser dialogs retain their original geometry. The keyboard skip link also stays below native controls.

### Verification

`npm run check` and `npm run build` pass. Desktop: **73 passed**. Integration: **531 total, 526 passed, five optional skips, zero failures**. The new disposable database was removed and absence verified; no live provider or connected account was called. Frozen source hashes remained unchanged. Full evidence: `.local/desktop-attachment-final-checks-summary.json`.

The actual attachment renderer passed a separate synthetic browser fixture: desktop CSV at 1100 × 760 starts at y=63 below the 48px title region; a dark portrait image at 700 × 500 keeps its controls visible and supports close, reopen and Escape. Web CSV at 1100 × 760 retains y=15 and a zero-offset overlay. This fixture simulates native chrome; it does not establish installed-app acceptance. Evidence: `.local/desktop-evals/evidence/attachment-fixture-bounds.json` and matching screenshots.

The new installed app prepared its runtime from 10:39:17.701Z to 10:39:35.471Z, **17.770 seconds**, and reached the macOS Keychain approval gate. The user subsequently approved it; the engine reached ready at 11:03:29.562Z. Native inspection on this exact bundle passed: the CSV modal clears the traffic lights, close/download controls remain visible, Escape returns to Chat, and the same preview reopens. Screenshot: `.local/desktop-evals/evidence/attachment-titlebar-after.png`. Smaller-window and image holdouts remain controlled-fixture evidence. Encrypted key bytes and the original conversation-session bytes were independently verified unchanged; a rollback app remains available. The matching DMG is verified: **405,068,330 bytes**, SHA-256 `d4b574e6991060e97dd493de227ca921e5f7cd5b0ca7d1a1ad77fbc9368ccd31`. Its read-only mounted app passed signature verification and matched all 148 shell/web files. This is 83.9% smaller than the original installer; the unchanged runtime pack makes the combined first download 2.16 GB. Exact metadata is in [README](README.md) and `.local/desktop-evals/evidence/keychain-preview-dmg.json`.

Replay remains available through **Otto → Replay onboarding…** without resetting conversations or keys. This is an ad-hoc signed local preview, not a notarized public release; a fresh Mac still needs the companion runtime pack until an immutable HTTPS release is published. Linux/Windows requirements and estimates are in [the platform plan](../docs/research/desktop-and-hosting-plan.md). Prior live assistant checks below belong to their named revisions and do not substitute for the current native UI gate.

## Earlier revision — four-step onboarding, 2026-10-02

Base: `f187ac8911beba6d091d54b3274312c67f13ef81`, freshly merged from `origin/main` before this UI iteration. The comparison was zero commits ahead/behind at that fetch; the desktop experiment remains uncommitted. Pi is 1.0.0. Earlier working patches and app copies were preserved.

The installed app is `~/Applications/Otto Preview.app`, deep/strict ad-hoc signature `04e72cf90584d7a4d68ca54a944f4e0f0b54c047`. All 21 desktop shell files match their source. The web entry remains `index-CmnC2Bje.js`; the current onboarding change does not alter the web build. Runtime release: `88904e5a1db4527ce90791a2296bf20740b0f5450ef84fad94b02f7a0eb4e81b`.

### Installed onboarding observations

See the authoritative [guided onboarding run](evals/runs.md#guided-onboarding-redesign--2026-10-02) for observed steps, unchanged profile data, and the incomplete theme matrix.

### Changes and controlled evidence

- Four guided steps cover provider keys, preferences, login/notifications, and readiness. Settings, activation, and second-instance entry points cannot bypass unfinished onboarding. Ordinary configured startup uses a full-window loading view.
- One shared runtime preparation operation starts without provider credentials. Provider saves remain available during warmup; the engine starts only after completed setup and a selected provider key. Runtime retry is explicit. Quit aborts and awaits preparation before stopping the computer.
- Preferences must finish persisting before Continue. The detected system time zone is saved when none was selected. A migrated/completed profile missing its selected provider key returns to provider setup instead of loading indefinitely.
- The computer/checkmark illustration and redundant notification reassurance are removed. Readiness uses actual stage text with an indeterminate indicator, not a claimed completion percentage. Repeated Settings row dividers are removed; notification jumps use a brief tint confined to the message body.
- One General/Providers/Preferences settings implementation remains available from the app, tray, application menu, and keyboard shortcut. Local mode omits Profile; provider keys stay masked until revealed, provider logos remain visible, and model text is read-only.
- Copy bug report stays visible at Chat’s top right. Unread counts retain owner/thread-scoped read positions without storing message text. Prior controlled web checks covered themes, mobile layout, reload persistence, off-Chat replies, and reading earlier history.
- Desktop suite: **66 passed, zero failures**. An independent focused rerun passed **5/5**, including empty-key OpenAI and Anthropic, delayed preference loading, and invalid quiet-hour recovery. These use synthetic data and the actual renderer/encrypted store, not a live provider.
- Full TypeScript/architecture/formatting, build, and integration results are recorded in the final checks below.

### Assistant and notification evidence

The current Pi 1.0 engine produced a downloadable CSV through the real app. Independent parsing verified all grouped amounts and EUR 48.50 total. Earlier installed checks established public browsing, workspace file creation, and a received download. The user directly confirmed the reminder banner contained the actual message and clicking it worked. That notification observation belongs to the earlier named bundle; notification behavior was unchanged in this onboarding update.

The full repeated/held-out assistant matrix remains incomplete. The CSV receipt was paused during product work and its normal composer Markdown-escaped an underscore, so its exact frozen input/time gate is not claimed despite the verified output. See [run records](evals/runs.md) for per-attempt boundaries and costs.

Pi 1.0 codemode overflow output was repaired at the workspace boundary: bounded, owned regular files are transferred into the sandbox inside the existing tool guard, host paths are replaced, and temporary files are removed. Actual SDK red/green, independent 9/9 holdout, and packaged Electron utility-process checks are recorded in [codemode output](evals/codemode-output.md). Automated checks did not call a live provider.

### Distribution and runtime

The DMG remains approximately **385 MB**, about **84.7% smaller** than the original 2.52 GB installer. Its separate verified runtime pack is **1,756,609,403 bytes**; combined first installation is approximately **2.14 GB**. The shell update reuses the same runtime, images, and dependency tree. Exact final artifact sizes and hashes are recorded beside `dist/desktop/Otto Preview-arm64.dmg` and in [the README](README.md).

The Pi 1.0 runtime upgrade preserved the original PostgreSQL container and all four named volumes. The actual runtime archive installed into an empty disposable cache, verified all 195 files, and reused that cache. Real disposable workspace checks covered PDF generation/extraction, OCR, HEIF, non-root execution, and absent host/provider credentials; the browser worker passed public navigation and screenshot/isolation checks. These are practical runtime checks, not a formal sandbox-escape or clean-Mac certification.

This is an ad-hoc signed local preview, not notarized public distribution. A fresh Mac still needs the matching runtime archive until a real immutable download URL is published. No release was published. PostgreSQL remains in the PoC; SQLite is the separately scoped storage milestone in the [research plan](../docs/research/desktop-and-hosting-plan.md).

An earlier installed launch encountered a native Virtualization.framework exception before Linux boot; an explicit retry recovered without a source change or data reset. That remains a reliability observation, with the bounded [upstream investigation](evals/native-startup.md) retained. Windows/Linux/Intel support, clean-machine onboarding, sleep/wake, battery behavior, connected-account actions, and the complete native visual matrix are not established.

### Final checks

`npm run check` and `npm run build` passed on the frozen shell source. Integration: **531 total, 526 passed, five skipped, zero failed** in 79.277 seconds. The disposable database was removed and its absence verified. Main/lifecycle/renderer hashes stayed unchanged throughout; the web entry hash also remained identical. Full evidence is `.local/desktop-guided-onboarding-checks-summary.json`. Mounted installer verification is recorded below when the matching DMG finishes.

## Historical revision — 2026-10-01

Host: Apple Silicon, macOS 26.6.2. The observations below apply to the preceding full installer, not the current frozen evaluation batch, public distribution, or cross-platform certification.

## Installed application

The application was installed at `~/Applications/Otto Preview.app`, with a profile independent of the normal Otto installation. Tests below used the installed bundle and its managed computer.

- The native setup window renders correctly and prepares the private computer without terminal, Node, Homebrew, Docker Desktop, or database setup by the user.
- Existing provider credentials were imported through the main process into OS-protected encrypted settings. No plaintext keys were entered into chat or placed in the application bundle.
- The existing OpenAI key permits inference but does not permit model listing. A real, explicitly authorized Responses request succeeded. Validation now recognizes the specific missing `api.model.read` permission; invalid credentials and other forbidden responses still fail.
- Optional app onboarding was skipped successfully. No external account was connected and no message was sent to a real recipient.
- A real chat request asked Otto to browse `https://example.com` and create `otto-desktop-check.txt`. The persisted session records successful browser, bash, write, read, and file-sharing tool results.
- The app rendered the resulting download link. Clicking it opened the native Save dialog. The downloaded file was independently read from `~/Downloads/otto-desktop-check.txt` and contained exactly:

```text
Example Domain
Created in Otto’s local workspace.
```

The read-only welcome message is not counted as live model evidence.

## Isolated runtime acceptance

A separate disposable VM was used before the installed-app test. It was then stopped and deleted; the normal Docker installation and its volumes were preserved.

- An authenticated PostgreSQL query succeeded; a synthetic database row survived a full VM stop/start.
- The existing workspace provider uploaded/read synthetic bytes and returned a Python-generated PDF with a valid PDF header. The file survived a VM stop/start.
- The existing browser provider opened a real public page and captured a screenshot.
- The workspace had no host home directory, immutable installer-assets directory, browser data volume, Docker socket, or provider credential environment variables.
- Attempts from the workspace to reach the host gateway, database network, browser network, and metadata address failed.
- The runtime used its dedicated Docker socket and bundled client, independently of the host Docker daemon.

These are practical isolation checks, not a formal sandbox-escape assessment.

## Performance observations

| Measurement                          | Observed result                                       |
| ------------------------------------ | ----------------------------------------------------- |
| Installed first preparation          | 285.490 seconds to engine readiness                   |
| Installed runtime portion            | 283.059 seconds                                       |
| Installed engine portion             | 2.431 seconds                                         |
| Disposable stopped-VM restart        | 19.005 seconds                                        |
| Already-running runtime preparation  | 367 milliseconds                                      |
| Disposable guest idle memory         | 538 MiB used, 754 MiB cache                           |
| Disposable host VM resident memory   | Approximately 2.16 GiB                                |
| Configured VM resources on this host | 6 GiB RAM, 4 virtual CPUs, 24 GiB sparse disk maximum |
| Bundled computer assets              | Approximately 1.7 GiB                                 |
| Final DMG                            | 2,520,851,495 bytes (2.52 GB)                         |

The installed first boot exposed a guest `systemd-logind` problem: two SSH/PAM gates each waited 120 seconds, and the service consumed one guest CPU. Cloud initialization itself completed in 8.6 seconds. The first installed boot is therefore not a healthy idle-performance baseline. On the first Quit, Lima hit its 30-second VZ stop timeout; all application and VM processes nevertheless exited and the VM reached Stopped. A similar readiness delay is reported in [Lima issue 4517](https://github.com/lima-vm/lima/issues/4517); matching symptoms do not prove an identical underlying cause.

On reopening the persisted installation, the runtime became ready in **15.125 seconds**. The login service used **0% CPU**, the guest used **494 MiB RAM**, and host VM resident memory was approximately **2.21 GiB**. No reset or guest maintenance was required.

The final signing change triggered macOS Keychain authorization before the reopened engine could decrypt its saved keys. Computer Use explicitly prohibits operating SecurityAgent, so approval was handed to the user. The reopened engine and native Settings interaction after that approval are not yet counted as passed. The earlier installed-app model/browser/download task and encrypted-storage tests remain separate successful evidence.

## Automated and artifact checks

- Root integration suite: 454 tests; 451 passed, 3 skipped, zero failures.
- An existing Vault fixture race was repaired by using database-clock timestamps with microsecond precision instead of JavaScript millisecond timestamps. The isolated Vault file and full parallel suite pass.
- `npm run check`: TypeScript, architecture boundaries, and formatting pass.
- `npm run build`: production web build passes. Existing large-bundle warnings remain.
- Desktop tests: 11 passed. They cover encrypted storage, redacted renderer responses, failed-key replacement rollback, explicit removal, restricted imports, unavailable key stores, provider destinations, redirect refusal, restricted model-list permissions, and bounded errors.
- Installed bundle passes deep strict ad-hoc code-signature verification. Lima retains its virtualization entitlement.
- The final DMG passes `hdiutil verify`. Its application was mounted read-only and independently passed deep strict signature verification; its signature matches the installed and distribution copies. The verification mount was detached. The DMG SHA-256 is `08707e7b9638bc86ee5b56580740af25bb8b330af2af907b691926b9b4e67de1`.
- Bundle audit found 56 symlinks and no target outside the bundle; no environment files were bundled.
- A scan of 61,986 bundled files found zero matches for the configured provider credentials.

## Evidence limits

Live account authorization, voice recording, external messaging, Windows/Linux/Intel support, clean-machine public distribution, notarization, updates, migration, sleep/wake, and battery behavior have not been established by these checks. Automated tests use synthetic data and disposable SQL schemas; the manually authorized provider/browser/file checks above are separate evidence.
