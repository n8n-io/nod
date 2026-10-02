# Desktop evaluation runs

## U06.v1 — compact onboarding and release contracts

User feedback: the guided onboarding window has excess space. Hypothesis: reduce its default dimensions from 680 × 760 to 620 × 640 and tighten onboarding-specific spacing while preserving normal Settings dimensions. Reject if provider controls, trust/Keychain guidance, or navigation clips or requires scrolling at the default size. The existing guided-step renderer checks remain the controlled holdout.

Native result: the installed `1b4095a435438abd96763300fe56460eb08d8a5a` app shows both provider and login/notification steps without clipping or scrolling at 620 × 640; Back returns to Providers. Only the completion flag was reset, with other settings and original session bytes preserved. The app is left at step one. Screenshots: `.local/desktop-evals/evidence/compact-onboarding-{providers,preferences}.png`. This checks layout in the installed ad-hoc preview, not CI signing or a new assistant task.

Release investigation retained three independent failures before their fixes: the upstream Lima binary required macOS 26 despite the app advertising 14; prepared release notes accepted later unrelated source changes; and self-signed hardened Electron code could not load its own framework without an Apple Team ID. The changes respectively rebuild pinned Lima for 14, bind packaging to the prepared source plus only release metadata, and add the library-validation exception only to self-signed Electron entitlements. Developer ID remains separate. CLI/native packaging evidence and its limits are in [VALIDATION](../VALIDATION.md); no hosted CI success or fresh-Mac installation is inferred from local fixtures.

## U05.v1 — attachment preview window controls

Frozen on 2026-10-02 before the fix. User request: “When seeing attachments, they render below the traffic lights of the app, we should fix that.” The supplied CSV preview screenshot fails the native clearance check: the modal begins inside the title-bar region. Base is `f187ac8` with the current experiment; the installed app is `2dfbeeb8d4ba95fa8bb528b504aada823bed1913`.

Hypothesis: dialogs center against the full window and attachments size against its full height, ignoring the 48px desktop title bar. Reserve that region in shared dialog placement and subtract it from attachment height. Reject the hypothesis if controls still overlap, preview content or actions clip, or browser placement changes.

Required checks for one native run: the existing synthetic CSV preview starts below the native controls, its close/download actions remain visible, Escape returns to Chat, and the preview can reopen. Holdout: a second attachment format and a smaller window retain clearance and usable controls. Browser regression: the same component retains its existing zero-title-bar geometry without the desktop bridge. Use existing synthetic artifacts or disposable UI data; no model or connected-account call. Capture native screenshots and source/build identity. UI inspection and controlled fixture evidence remain separate, with any missing check reported as unmeasured.

Implemented in installed app `d3e7779398c476d664181c8c70b208da1fb1054b`, web `index-D4biaBAx.js`. Shared dialog placement and attachment content heights subtract native chrome; the focused skip link also reserves that space. The preceding installed preview screenshot is retained as `attachment-titlebar-before.png`.

Controlled UI evidence: the production ImageViewer with synthetic fixtures puts desktop CSV at y=63 below the 48px reserved area, while a 700 × 500 dark portrait preview retains its image, close, navigation and download controls. Close, reopen and Escape were exercised. Web CSV keeps y=15 and overlay y=0 at 1100 × 760. The fixture's native chrome is simulated; its result is not a native pass. Bounds and screenshots are under `.local/desktop-evals/evidence/attachment-*`. Type/architecture/format/build checks pass, desktop checks pass 73/73, and disposable integration passes 526 with five optional skips and zero failures.

The updated app visibly explained Keychain access during startup. The user completed the macOS approval and the engine reached ready at 11:03:29.562Z. The native CSV check passed on the named bundle: modal below traffic lights, close/download controls visible, Escape back to Chat, and successful reopen. Screenshot: `.local/desktop-evals/evidence/attachment-titlebar-after.png`. The second-format and smaller-window holdouts remain fixture evidence. A separate audit found that the emoji picker's independent placement still clamps to the full viewport; that is a follow-up outside the attachment fix. Native Settings bypasses the web mobile-settings overlay, so its mobile fullscreen rule is not part of this Mac failure.

## Guided onboarding redesign — 2026-10-02

The user rejected preparation inside the Settings sidebar and requested four guided steps with background preparation. The frozen case, baseline failure, and pre-fix hypothesis are in [guided onboarding](guided-onboarding.md). This supersedes the two-step U03 design without changing its historical observations.

The guided version is installed as app `04e72cf90584d7a4d68ca54a944f4e0f0b54c047`. Resetting only the completion flag opened the provider step; Continue opened preferences, with all controls fitting the default window. Runtime warmup ran from 10:19:14.175Z to 10:19:31.479Z (17.304 seconds) while setup was incomplete, and no engine utility process existed before completion. The existing Chat was visible after engine readiness at 10:19:54.184Z. Private evidence: `.local/desktop-evals/evidence/guided-onboarding-native.json` and `guided-onboarding-bundle.json`. Encrypted keys and original session bytes were verified unchanged. The user interacted with the UI during the pass, so further native automation stopped; the complete theme/step matrix is not claimed. The 66 desktop checks and independent five-case renderer run are green, as are check/build and the 526-pass integration suite with five optional skips.

### U03.v3 — installed readiness notification

Installed app CDHash `2dfbeeb8d4ba95fa8bb528b504aada823bed1913`, web entry `index-D9HqtqeI.js`, macOS arm64. The native run began at the provider step with masked keys and no Settings navigation. Otto was hidden during computer preparation, which ran from 10:29:59.271Z to 10:30:17.489Z. Existing encrypted keys and original session bytes were verified unchanged.

The user directly confirmed that the readiness banner appeared and clicking it worked. This supplies the previously missing human OS-banner and activation evidence for this installed attempt; it is user-confirmed rather than independently observed by the UI tool. It does not establish every quiet-hours, opt-out, or startup permutation, which remain controlled contract evidence. Private record: `.local/desktop-evals/evidence/three-step-onboarding-native.json`.

The frozen source passed 73 desktop checks and 526 integration checks, with five optional integration skips, zero failures, and verified removal of the disposable database. Check and build passed. These results precede the later Keychain explanation and attachment-overlay changes and do not validate those changes.

### T02.v1 — Pi 1.0 installed artifact check

On base `f187ac8911beba6d091d54b3274312c67f13ef81`, installed app CDHash `91d95622d4a35dd15218af638f91f48c7ec6df6a`, Pi 1.0.0, the normal composer produced a CSV in 15.248 seconds (10:04:00.549Z–10:04:15.797Z). The artifact was received through the native Save dialog. Independent CSV parsing with decimal arithmetic verified the exact header, four expected rows, grouped values, and total EUR 48.50. Download SHA-256: `cc1bb6e022c36a5d1ca222d51221f7e09b85dc6a7222d5a6fae7ad22ddc8ae02`. Pi-reported cost: USD 0.069192.

T02-C1/C2/C3 pass. This is not a full frozen-case pass: the normal rich-text composer escaped the underscore in `total_eur`, and evaluator receipt was paused while handling product feedback, so exact-prompt S01 and continuous receiving-time S05 were not established. Both prompt hashes and the difference remain in `.local/desktop-evals/evidence/T02-final.json`; the resulting column name is correct. The held-out CSV case remains unrun.

## Visible diagnostics, notifications, and unread state — 2026-10-02

U04.v1 is a rejected design: the user explicitly wants Copy bug report visible in Chat and rejected the overflow menu/focus treatment. U04.v2 preserves the compact desktop toolbar and makes diagnostics directly available. The persistent per-key Saved labels were redundant; the settings still retain key masking, explicit reveal/change actions, and meaningful import provenance.

Notification hypothesis before the fix: the native watcher reduces new committed assistant messages to a boolean, leaving the banner constructor no text to show. Forwarding the latest new message from the existing redacted API should allow a readable preview while preserving opt-in, focus, quiet-hours, and deduplication. Reject if previews expose markup/hidden link targets, replay old history, cross thread/owner boundaries, or require raw trace/tool data.

Unread hypothesis before implementation: the web UI has no read-position tracking, and desktop localStorage is insufficient across changing loopback ports. A small owner/thread-scoped read cursor should retain counts across window/app restarts without persisting content. Clearing must require a focused, visible Chat at its latest messages. Controlled and native results are recorded separately.

Web comparison: the existing localhost:4310 instance belongs to another modified checkout at `85ad559`; it is not this worktree's `95c8d3f` base. It was opened read-only and left intact. Current-worktree browser checks use a separate localhost:4312 fixture with synthetic account/messages, no provider keys, and no model or connected-account calls.

### ENV-03.v1 — installed notification/unread update

Installed after a clean Quit with a separate rollback copy and no profile reset. App CDHash `70228a69db11e0baf29969d1eb0ef60fd2d1791a`, web entry `index-D2pymzKD.js`, unchanged runtime release `5a81d8dada03b68ec197bbba1634c7d8341c016a31954191a60423afb16c0fbe`. Preparation started 09:39:45.906Z, runtime ready 09:40:02.326Z, engine ready 09:40:22.069Z. Deep/strict app and mounted-DMG signatures, source equality, descriptor/cache resolution and bundle-boundary checks pass.

Current checks: `npm run check` and build pass; 56 desktop tests pass; integration 514 passed, five skipped, zero failed in a new disposable database, then removed. The DMG is 380,786,035 bytes, 84.9% below the original, with a separate unchanged 1,718,464,915-byte runtime pack. This is an ad-hoc signed local preview, not a notarized public release.

### U04.v2 / U05.v1 — current observed UI checks

The installed app shows one General/Providers/Preferences window, masked keys with reveal/change actions, no persistent Saved labels, a read-only model, and date/time/quiet hours. Chat has a direct Copy bug report action; clicking it visibly changed to Copied. Current native screenshots are ignored artifacts in `.local/desktop-evals/evidence/providers-installed.png` and `chat-installed.png`.

Controlled current-source browser checks at localhost:4312 passed: initial history has no unread badge; two replies on Apps show two in collapsed and expanded navigation; reload preserves two; latest visible Chat clears it; another reply at the focused bottom stays read; moving to earlier content produces one unread reply until returning to the latest content. These use synthetic messages and the real web frontend, not a live model/backend. Dark settings preserve Profile and Preferences in hosted mode, and the 390px mobile layout retains the visible bug-report action and usable composer. The existing actual localhost:4310 instance was opened read-only; it runs an older separate checkout and was left intact.

An earlier visible fixture showed an unsupported onboarding action as “Unavailable in this isolated UI fixture.” This was a fixture limitation, not the installed app. The visible tab was returned to the real web instance and remaining controlled checks ran in a hidden tab.

### U03.v1 — installed onboarding replay

On app `70228a69db11e0baf29969d1eb0ef60fd2d1791a`, the native application menu exposed Replay onboarding. It opened the provider step with masked existing keys, Continue opened the login/notification choices, and Open Otto returned to the existing Chat. Existing choices and key metadata remained intact; no keys were revealed or replaced. Native screenshot: `.local/desktop-evals/evidence/onboarding-replay-installed.png`. Empty-key/provider holdout validation remains the separately recorded synthetic case.

### U02.v1 — native preference persistence observation

On the same installed UI build, Quiet hours changed from on to off, Settings was immediately closed and reopened through the keyboard shortcut, and Preferences still showed off. Restoring on retained the original 22:00–08:00 interval. Dark appearance covered Settings and Chat; the original System appearance was restored afterward. Native select-popup manipulation could not be established through the UI tool, so the clock value remained Automatic. This ordinary close/reopen check complements the separate delayed-save synthetic base/holdout cases.

### T03.v1 — final-bundle reminder, partial native acceptance

The exact frozen prompt was sent through the installed composer. One `schedule_create` succeeded at 09:41:35.610Z, due at 09:43:30Z. The normal dispatcher started the turn at 09:43:32.238Z; one `send_message` succeeded at 09:43:34.832Z. The exact text “The Otto desktop reminder check is complete.” appeared once in native Chat at 10:43 Europe/Lisbon (09:43 UTC). The sidebar showed one unread reply on Schedule, then no badge when the latest Chat was visible. No duplicate dispatch or delivery appeared through 105 seconds after the due time. Pi-reported setup plus execution cost: USD 0.0114943.

T03-C1/C2 pass. T03-C3 remains incomplete because the window-close condition could not be established while the app was also being inspected. Notification Center could not be inspected with the available UI automation. The user directly confirmed “Banner text and click both worked.” This is user-observed OS acceptance on the named bundle, distinct from the automated trace and native Chat observations. Private trace and receiving-UI evidence: `.local/desktop-evals/evidence/T03-final.json` and `chat-installed.png`.

### T01.v1 — real pre-update runtime check

One native attempt passed on the installed `17223ceb297212e41f6444a1fecafcd939de9d92` app before the notification/unread update. The exact frozen task was sent through the normal composer at 2026-10-02T09:32:45.877Z; the assistant completed at 09:33:13.119Z using OpenAI `gpt-6.1-sol`. Successful browser, workspace write/read, and share-file receipts were inspected. The link opened the native Save dialog, and the saved `~/Downloads/otto-desktop-eval.txt` independently contained the correct public page title and description. Public source bytes matched before and after the run.

S01–S05 and T01-C1–C3 passed for this attempt. Download SHA-256: `fbe70074d91ba18043cf8c6930c3b5cbb5104aa43067b0145ecc8a7f22f4ec5f`. Reported model usage cost: USD 0.0214245. Private evidence: `.local/desktop-evals/evidence/T01-preupdate.json`, containing bounded trace metadata and hashes, no credentials. This is one pre-update success; repeated/holdout reliability and the final notification/unread bundle remain separate gates.

## U04.v1 — header refinement

User screenshot baseline: fail U04-C1 and U04-C3. The desktop reserves a 32px empty drag strip, Chat adds a second 60px header, and the collapsed sidebar stacks its logo and toggle above a further navigation gap. Diagnostics occupy a primary-looking text action. Classification: product UX gap.

Hypothesis before the fix: independent desktop and web headers cause the disconnected spacing. A shared 48px desktop toolbar with navigation and contextual actions should remove the duplicate rows while retaining native controls and all entry points. Rejection evidence: overlap, clipping, inaccessible navigation/actions, or the second row returning during loading, navigation, or theme changes. Hosted and mobile behavior must remain usable.

Proposed change: one workspace toolbar, sidebar navigation directly beneath it, a secondary Chat options menu, and a matching loading shell. Installed visual checks pending.

Implemented on app CDHash `17223ceb297212e41f6444a1fecafcd939de9d92`, web entry `index-CPzONTHe.js`. Review caught an adjacent narrow-window failure: the sidebar toggle could say expanded while responsive CSS kept its labels hidden. Desktop expansion now works above the mobile breakpoint; native zoom below that breakpoint uses the existing mobile navigation. These are static-review findings; no native visual pass is claimed yet.

Current regression checks passed: TypeScript, architecture boundaries, formatting, production build, 48 desktop tests, and the integration suite (511 passed, five optional native checks skipped, zero failed). Integration ran in a newly created disposable database that was removed afterward. An initial integration invocation lacked database configuration and stopped before any tests; that setup failure is retained in the private log.

Environment update: the user completed the earlier macOS approval; the unchanged previous bundle recorded `Engine ready` at 2026-10-02T08:49:53.889Z. The earlier Keychain block below is historical; it is no longer the current dependency.

### ENV-02.v1 — installed header build

The updated app was installed over the preview after a clean Quit, preserving its profile and a separate rollback copy. Deep/strict signature verification passed. Startup began at 2026-10-02T09:00:57.864Z and prepared the same runtime at 09:01:16.174Z: **18.310 seconds**, without the earlier native VZ exception. The new ad-hoc signature triggered a fresh macOS Keychain prompt before engine launch. User approval was requested through the ongoing task. U04 and the live assistant cases remain unscored while that OS approval is pending. No key bypass, profile reset, or credential replacement was attempted.

The frozen cases and gates are in [README](README.md). No assistant case has been scored yet on the final repaired bundle. Earlier successes from 2026-10-01 are historical evidence only and do not pass the current cases.

## Preflight findings retained before the frozen batch

| Finding | Observed red and classification                                                                                                        | Hypothesis, prediction, rejection evidence                                                                                                                                                                                                                                                                                                                                    | General fix                                                                                                                                                         | Verification boundary                                                                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PF01    | The installed lean app asked for a runtime pack despite a verified cache. Product packaging failure.                                   | The release descriptor was omitted because a copy filter evaluated absolute paths containing `.local`. Prediction: descriptor absent from packaged engine; explicit relative-source copying includes it. Reject if the descriptor already exists and resolves the cache.                                                                                                      | Filter source-relative paths; assert destination descriptor/archive hashes.                                                                                         | Descriptor was absent, then present with matching hash. Packaged runtime module resolved the cache. Real filesystem regression passed. Installed engine still required the independent PF02 repair. |
| PF02    | Installed launches at 2026-10-01T23:57:00.827Z and 2026-10-02T00:01:15.989Z never reached chat. Product runtime failure.               | Initial database-readiness suspicion was rejected by an authenticated `SELECT 1`. Browser worker exited because current main imports `src/shared/browser-handoff.ts`, omitted by the image's explicit file list. Prediction: copying the complete relevant source directories starts the worker. Reject if that module is present or worker startup fails for another reason. | Copy the browser's complete shared/port/provider directories; run actual browser-provider acceptance during packaging; fail early when the worker container exits.  | Disposable real worker navigated the public page and captured a screenshot, including under production read-only/capability/resource restrictions. Installed upgrade acceptance pending.            |
| PF03    | Native notifications did not consult quiet hours. Product behavior gap.                                                                | Notification construction only checks opt-in/focus. Prediction: a reply during configured quiet time reaches `Notification.show`. Reject if an earlier native delivery guard applies the same interval.                                                                                                                                                                       | Apply persisted quiet-hour/timezone semantics before native delivery and recheck focus/engine identity after async reads.                                           | Exact start/end, overnight, disabled, equal-time, timezone, and DST checks pass. Actual macOS delivery is not established by these tests.                                                           |
| PF04    | Changing preferences during startup replaced progress/error text; navigating back to Settings could hide recovery. Product UX failure. | Shared status mutation overwrites runtime status, and the retry action exists only in a hidden preparation panel. Prediction: a preference save erases the actionable failure; reopening General has no retry. Reject if the failure and retry remain reachable.                                                                                                              | Preserve preparing/starting/error status on preference-only saves; add retry beside errors in Settings; record bounded preparation failures in private diagnostics. | Renderer contract retains recovery after navigating to General and invokes preparation once. Native final-bundle acceptance pending.                                                                |
| PF05    | A second preference edit can disappear if Settings closes during the first online save. Product persistence failure.                   | See the frozen hypothesis and delayed-response case in [preferences persistence](preferences-persistence.md).                                                                                                                                                                                                                                                                 | Each edit enters the native queue immediately; stale responses cannot replace newer state.                                                                          | Primary red 0/3, primary green 3/3, independent holdout 3/3. Synthetic evidence retained separately.                                                                                                |

These preflight observations do not substitute for the frozen installed-app task gates. They retain failed outcomes and the evidence that changed the diagnosis.

## Regression evidence before the installed batch

- Base: `95c8d3f`; experiment changes uncommitted.
- Root integration: 516 tests, 511 passed, 5 skipped, zero failures. Synthetic data and disposable schemas; no live provider calls.
- `npm run check`: TypeScript, architecture boundaries, and formatting passed.
- `npm run build`: production web build passed.
- Desktop focused suite after PF05: 48 passed, zero failures; includes persistence and empty-key onboarding base/holdout cases.
- Browser worker: real disposable container and public page, no model provider or connected account. This is isolated runtime evidence, not installed-app acceptance.

## Frozen attempts

### ENV-01.v1 — final installed launch

| Field             | Record                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build             | Base `95c8d3f`, app CDHash `ce253f259f767ed768dc78be73c1138dfd569011`, runtime `5a81d8dada03b68ec197bbba1634c7d8341c016a31954191a60423afb16c0fbe`, Apple Silicon macOS 26.6.2.                                                                                                |
| Attempt 1         | 2026-10-02T00:15:22.744Z–00:15:25.315Z. Fail before engine launch: native Virtualization.framework exception. No model call or charge.                                                                                                                                        |
| Hypothesis        | A transient native VZ failure rather than corrupt cached binaries or configuration. Prediction: unchanged binaries/configuration can start on one explicit retry. Rejection: repeated identical failure or failed integrity/entitlement/configuration checks.                 |
| Evidence          | Cache executable matches the previous working release byte-for-byte; signature and virtualization entitlement verify; configuration has the expected read-only mount. Bounded host log identifies an Objective-C selector exception before Linux boot.                        |
| Attempt 2         | Native Try again invoked explicitly. 2026-10-02T00:16:36.072Z–00:17:01.133Z: runtime prepared in 25.061 seconds, all three private containers running. No reset, source change, or automatic retry.                                                                           |
| Result            | Runtime recovered; engine gate blocked at macOS Keychain approval for saved provider keys. `SecurityAgent` is active and no current `Engine ready` record exists. User handoff requested; no assistant case started. The native VZ failure remains a reliability observation. |
| Evidence location | Private startup log, ignored `.local/desktop-evals/evidence/build.json`, `.local/desktop-runtime-archive-acceptance.json`, packaged file/signature checks. No credentials copied into records.                                                                                |

### Historical matrix before OS approval

| Case            | Status                                      | Evidence / missing dependency                                                                                                                                                 |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U01.v1          | Blocked                                     | Earlier native UI inspections are retained separately; final app is waiting on Keychain before full chat/menu/theme evaluation.                                               |
| U02.v1          | Synthetic gates passed; native gate blocked | Original failure and fix plus independent holdout each repeated three times; native close/reopen waits on OS approval.                                                        |
| U03.v1          | Native replay blocked                       | OpenAI base and Anthropic empty-key holdout pass in the [actual-renderer fixture](onboarding-fixture.md); installed replay still requires OS approval.                        |
| T01.v1, T01H.v1 | Blocked before scoring                      | Provider key cannot be decrypted until macOS approval. Public source snapshots and exact prompt hashes are frozen in ignored `.local/desktop-evals`; no live attempt started. |
| T02.v1, T02H.v1 | Blocked before scoring                      | Same OS dependency; independent decimal answer keys are ready outside the assistant context.                                                                                  |
| T03.v1, T03H.v1 | Blocked before scoring                      | Same OS dependency; no schedule created.                                                                                                                                      |

At the time of this historical matrix, no assistant attempts had executed. Later attempts and their costs are recorded above; the complete repeated/held-out reliability rate remains unmeasured.
