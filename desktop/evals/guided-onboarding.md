# Guided local onboarding

Frozen on 2026-10-02 before implementation. This versions the earlier two-step U03 case because the user now requires preferences, a guided sequence, background preparation, and a separate readiness screen. U03.v1 and its observations remain in the run log.

## U03.v2

Source request: “The onboarding should be about asking the user about their AI provider keys, setup their preferences and startup at login and notifications and then show the loading state of the computer/browser, which should already be done on the background.”

Setup: Apple Silicon macOS, the installed Otto Preview experiment, base `f187ac8911beba6d091d54b3274312c67f13ef81`, existing encrypted credentials and conversations retained. Record the exact source hashes and bundle identity per attempt. This UI case requires no model call. The native run uses existing masked keys; credential validation failures and first-install races use disposable synthetic fixtures. Never expose real keys in screenshots or evidence.

Action limit: replay onboarding, temporary local preference changes with restoration, normal app restart, and profile-preserving runtime preparation. Do not clear the database, browser, conversations, keys, or runtime volumes. Finish by leaving onboarding at its first step for user review.

| Check   | Applies when     | Pass condition                                                                                                                                          | Evidence and method                                                       |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| U03-C1  | Every run        | Provider, preferences, startup/notifications, and readiness appear in that order, with explicit Back/Continue controls before readiness.                | Native UI and renderer contract; human/code                               |
| U03-C2  | Every run        | Settings navigation and its menu entry points cannot jump an unfinished setup into unrelated settings sections.                                         | Native UI plus native entry-point contract; human/code                    |
| U03-C3  | Every run        | Back retains entered choices and existing keys stay masked and unchanged.                                                                               | UI and synthetic storage assertions; human/code                           |
| U03-C4  | Cold runtime run | Runtime preparation begins before provider submission and one preparation operation is reused by final startup.                                         | Lifecycle trace with paused preparation and delayed credential save; code |
| U03-C5  | Cold runtime run | Provider save can complete during runtime preparation; no engine starts before completed setup and a selected provider key.                             | Lifecycle contract; code                                                  |
| U03-C6  | Readiness run    | The final screen reflects actual preparation, readiness, or an actionable error; no artificial percentage or computer/checkmark graphic.                | Native UI and status contract; human/code                                 |
| U03-C7  | Failure run      | A preparation or validation error retains choices and offers an explicit retry without replaying an agent action.                                       | Controlled failure and successful explicit retry; code                    |
| U03-C8  | Every run        | The trust explanation accurately distinguishes local storage/execution from provider, browsing, and connected-service communication.                    | Source/UI review; human                                                   |
| U03-C9  | Every native run | Onboarding uses the full window without clipped controls in Light and Dark; normal Settings remains one General/Providers/Preferences window afterward. | Native visual review; human                                               |
| U03-C10 | Every native run | Completion reaches the existing Chat, and reopening onboarding preserves the existing profile and preferences.                                          | Native receiving UI plus bounded state metadata; human/code               |

Base: one installed replay, then one genuine incomplete-onboarding launch using only the completion flag reset. Holdout: empty-key Anthropic setup with a delayed runtime, failed validation, explicit retry, and Back navigation in a synthetic renderer/lifecycle environment. Fifteen minutes per UI attempt, excluding build/OS approval time; contract tests have their existing test timeouts. A required unmeasured check is incomplete, not a pass. Native visuals and controlled cold-start contracts are reported separately.

## Baseline and hypothesis

User screenshot fails U03-C1, C2, and C6: loading is presented inside General settings with freely selectable navigation, an unrelated computer/checkmark symbol, and unused space. The current startup function also reads the provider and completed-onboarding gate before preparing the local runtime, so preparation cannot overlap the user's setup.

Hypothesis: coupling runtime preparation to engine launch and reusing settings navigation creates both delays and the misleading page structure. Separating an idempotent background preparation operation from credential-dependent engine launch, and introducing a bounded renderer wizard, should overlap preparation with setup while keeping the user on one guided path. Reject the hypothesis if warmup still waits for provider submission, duplicate preparation appears, settings entry points escape the wizard, or returning through Back loses entered state.

## Attempts

### Attempt 1 — implemented and partially observed in the installed app

Base `f187ac8`; app CDHash `04e72cf90584d7a4d68ca54a944f4e0f0b54c047`; unchanged runtime `88904e5a1db4527ce90791a2296bf20740b0f5450ef84fad94b02f7a0eb4e81b`; macOS arm64. No model request was made for this onboarding check.

The installed profile's completion flag was reset without touching credentials or conversation storage. Native observation confirmed masked provider fields, the upfront trust explanation, no Settings sidebar, and Continue opening the preferences step. Every preference control fit within the default 680 × 760 window. Computer warmup began at 10:19:14.175Z while onboarding was incomplete and there was no engine utility process. It finished at 10:19:31.479Z; the existing Chat was visible after engine readiness at 10:19:54.184Z. That interval includes setup interaction, not only engine startup.

The UI tool subsequently reported user interaction, so further native automation stopped. The native run does not establish the complete four-step/theme matrix. Source/lifecycle checks establish the remaining state transitions separately. Encrypted credential bytes and the original session bytes were independently verified unchanged. Private evidence: `.local/desktop-evals/evidence/guided-onboarding-native.json` and `guided-onboarding-bundle.json`.

Controlled results: 66/66 desktop checks pass. Independent actual-renderer OpenAI/Anthropic empty-key and preference edge checks pass 5/5, with frozen source hashes. They cover guided order, masked-key retention, Back, delayed persistence, explicit retry, missing selected keys, shared warmup, and abort/cleanup. Root check/build pass; integration passes 526 with five optional skips and zero failures in a fresh disposable database. These are not first-install, live-provider, or native OS permission evidence.

Case result: partial native acceptance with controlled gates green; U03-C9's complete installed theme matrix remains unmeasured. The app is available for direct user review through Replay onboarding.

Independent review also identified a recovery gap before packaging: a profile with `onboardingCompleted: true` but no key for its selected provider was routed into loading, while startup skipped the engine preparation that would report the missing key. The predicted outcome is an endless loading screen. The recovery fix must route that state to provider setup, including a provider change that leaves only the other provider's key present. This is a separate migration/recovery regression, not evidence from a real user's reset profile.

## U03.v3 — detected defaults and a return notification

The user reviewed v2 and removed date/time setup from onboarding: detected defaults should apply automatically, with customization later in Settings. They also requested a notification when computer preparation finishes after leaving the app. This changes the design; v2's four-step gate is retained above instead of being relabeled a pass.

Frozen before the next installed attempt: providers → login/notifications → readiness. Appearance follows System; existing explicit date/time preferences remain, and an unset time zone is detected. Existing General/Providers/Preferences remain accessible after setup. The Settings title strip and duplicate desktop page names are removed, while the sidebar control, native window controls, and Chat bug-report action remain usable.

New checks: U03-C11 requires three guided steps with no date/time questions; U03-C12 requires explicit saved preferences to survive automatic defaults; U03-C13 requires the matching completed runtime to produce one generic readiness notification only when opted in, outside quiet hours, and backgrounded; U03-C14 requires notification activation to open the current setup or ready Chat without the readiness transition stealing focus; U03-C15 requires focused, opted-out, already-consumed, quitting, and ordinary completed-profile startup states not to emit that notification. Notification opt-in is durable immediately when the user chooses it; setup completion is still explicit.

Use one installed incomplete-onboarding launch with existing encrypted keys and notification preference, hide the window during warmup, then independently observe readiness. Ask for direct human OS-banner/click observation where the native automation cannot inspect Notification Center. Controlled transition/deduplication/quiet-hour checks are separate. Use one base and one held-out event ordering in the contract suite; no live model call is needed. Retain U03-C2 through C8 and C10 from v2 where applicable; C1 becomes the three-step order, and visual C9 applies to the updated layout. Fifteen minutes for native inspection, excluding build/OS approval time.

Hypothesis: removing predictable defaults from the wizard reduces effort without reducing control, while a one-use preparation receipt plus durable notification choice can bring an absent user back without reopening windows or duplicating assistant notifications. Reject if explicit settings are overwritten, opting out still notifies, a completed replay emits a fresh readiness notification, or runtime completion forces focus.

### Attempt 1 — installed notification accepted by the user

Installed app CDHash `2dfbeeb8d4ba95fa8bb528b504aada823bed1913`, web entry `index-D9HqtqeI.js`, macOS arm64. The native run began at the provider step with masked keys and no Settings navigation. Otto was hidden during computer preparation, which ran from 10:29:59.271Z to 10:30:17.489Z. Existing encrypted keys and original session bytes were verified unchanged.

The user directly confirmed that the readiness banner appeared and clicking it worked. This supplies the previously missing human OS-banner and activation evidence for this installed attempt; it is user-confirmed rather than independently observed by the UI tool. It does not establish every quiet-hours, opt-out, or startup permutation, which remain controlled contract evidence. Private record: `.local/desktop-evals/evidence/three-step-onboarding-native.json`.

The frozen source passed 73 desktop checks and 526 integration checks, with five optional integration skips, zero failures, and verified removal of the disposable database. Check and build passed. These results precede the later Keychain explanation and attachment-overlay changes and do not validate those changes.
