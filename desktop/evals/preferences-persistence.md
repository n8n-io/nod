# Preference persistence evaluation

This is a synthetic renderer and native-store contract evaluation for the Otto desktop Settings persistence refinement. It does not establish installed Electron or live engine acceptance; the parent task owns those checks.

These hashes and scores describe the uncommitted source snapshots at the original red/green attempts, before later onboarding and Settings changes. They do not identify the current PR or release assets. Current CI reruns the committed persistence regressions; it does not rerun an independent holdout because that synthetic case is now disclosed.

## Frozen case

| Field             | PERSIST-01.v1                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-style prompt | Change my region to United Kingdom and clock to 24-hour, then close Settings.                                                                                                                                                                   |
| Setup             | Actual `preferences.js` and Settings HTML in JSDOM; actual native preference store on disposable disk; synthetic engine preferences initially `en-PT`, `Europe/Lisbon`, `auto`, quiet hours enabled from `22:00` to `08:00`.                    |
| Timing            | Open Preferences; change region; hold the first online GET before it returns; change clock while the request remains held; destroy the renderer; release the request; await main-store operations; reopen the store from disk while offline.    |
| Expected result   | Both selected values survive closing Settings; all unrelated preferences remain unchanged.                                                                                                                                                      |
| Answer key        | Exact initial values plus `locale: en-GB` and `hourCycle: h23`, asserted independently against a reopened native store.                                                                                                                         |
| Action limit      | Disposable local files only; no real engine, account, provider, model, recipient, or external network.                                                                                                                                          |
| Run rule          | Node 26.7.0, macOS, `TZ=Europe/Lisbon`, deterministic harness with no model; three repetitions per red and green attempt; ten-second limit per repetition.                                                                                      |
| Base commit       | `95c8d3ffed646a6be07cd738ecd73b4fefec8de6`, with the current desktop experiment working-tree changes.                                                                                                                                           |
| Input hashes      | SHA-256: renderer `eb51ab0746d38af7fdad45f2ad963015bd7cf9be1296852b3b3efe9a0feba151`; HTML `c627b01677346ed34493e69e136265b4ae5665699b61945426de8bf5f2257c5a`; native store `b9edf30f483050a01abc5b64e978b83ce23cbee0a00f6cb5f372ce57565b8b88`. |
| Holdout           | PERSIST-HOLDOUT-01.v1: an independent agent selects different fields and expected values, then scores the same timing contract without sharing its answer key with the fixing agent.                                                            |

| Check      | Applies when                                                    | Pass condition                                                                                            | Evidence and method                                                   |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| PERSIST-C1 | Both controls emit valid changes while the first save is held.  | Both changes reach the main-process save queue before renderer destruction.                               | Captured bridge invocations; code assertion.                          |
| PERSIST-C2 | Queued main-store operations finish after renderer destruction. | A separately opened offline store contains both final selected values and the unchanged unrelated values. | Actual disposable preference file and reopened store; code assertion. |

The case passes only when both checks pass in every frozen repetition. A harness failure is an error, not a pass. The final change gate also requires the independently scored holdout and related desktop regression tests to pass.

## Hypothesis recorded before the fix

| Field                   | Record                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red check               | PERSIST-01.v1, anticipated failure of PERSIST-C1 and PERSIST-C2.                                                                                                                                                     |
| Cause                   | The renderer serializes saves by waiting for the first IPC response. A subsequent edit remains only in its `drafts` map, so destroying the window prevents that edit from reaching the surviving main-process queue. |
| Prediction              | Before close, the trace contains the locale save only; after release and disk reopen, the region has changed but the clock remains `auto`.                                                                           |
| Rejection evidence      | Both saves have already entered the native queue before close, and both values persist after independent reopen.                                                                                                     |
| Intended general change | Hand each accepted change immediately to the existing serialized native store, while fencing stale responses and retaining failed drafts for retry. No field- or fixture-specific branch.                            |

## Attempts

| Attempt             | Build and inputs                                                                                                 | Result                                                                                                     | Evidence                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PERSIST-01.v1 red 1 | Base commit and renderer/HTML/store hashes above; frozen prompt, setup, timing, and three repetitions unchanged. | Fail in 3/3 repetitions; pass-at-least-once 0%; pass-every-time 0%. PERSIST-C1 and PERSIST-C2 both failed. | `/tmp/otto-preferences-persistence-red.log`; every trace had the new locale but `hourCycle: auto` both in the queued preferences and after independent disk reopen. Total harness elapsed time 750 ms. No model or external request; cost unavailable. |

The observed red matches the prediction and is an application persistence gap, not a harness or evaluator fault. The original red log is retained. Green and independently scored holdout results follow after the general fix.

### Fixed renderer

Each accepted edit now invokes the existing serialized main-store save immediately. Overlapping responses remove only drafts with the acknowledged revision, and a stale response cannot replace a newer preference snapshot. The renderer retains failed drafts for retry when Preferences opens again. The change applies to every preference field.

The Settings-window close contract is the scope of this evaluation. It does not claim that a process crash during an unfinished main-store operation is durable.

| Attempt                        | Build and inputs                                                                                                                                                                 | Result                                                                                                   | Evidence                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| PERSIST-01.v1 green 1          | Same commit, prompt, HTML, native store, setup, timing, checks, and repetition count. Fixed renderer SHA-256 `b1cb0880106bf35a989a30ad5ff98dfb908fa98d3b4d61443eadaf1adfca8ea6`. | Pass in 3/3 repetitions; pass-at-least-once 100%; pass-every-time 100%. Both checks passed in every run. | `/tmp/otto-preferences-persistence-green.log`, 656 ms. |
| Related preference regressions | Same fixed renderer; existing native-store, preload, and onboarding preference tests.                                                                                            | 13/13 tests passed, including the frozen case's repetitions.                                             | `/tmp/otto-preferences-related.log`, 619 ms.           |

Exact prompt SHA-256: `96796b8570ba214642adb6d4e26a81573a9cfa7264ba7abb76d1848d519488ec`.

| Run     | UTC start                | UTC end                  | Log SHA-256                                                        |
| ------- | ------------------------ | ------------------------ | ------------------------------------------------------------------ |
| Red     | 2026-10-02T00:10:15.935Z | 2026-10-02T00:10:16.864Z | `f7298407a5a1320aa81fd1b61ea275efe5d4c2d0621d84a9a3068ac1cb9fa864` |
| Green   | 2026-10-02T00:11:05.470Z | 2026-10-02T00:11:06.255Z | `37b35376c6acb806ffb60242d1dbc609e6e0c0ab61259a4b798afc3bc8a67de0` |
| Related | 2026-10-02T00:11:33.536Z | 2026-10-02T00:11:34.181Z | `dab58d16571118fbd1fba25e991289421bbdade43541a1421e028657fc75bebe` |

Times are the captured log's filesystem creation and final-write timestamps; elapsed times are Node's reported harness durations. All runs use synthetic responses, disposable files, and no model. Monetary cost is unavailable. The fixing agent did not inspect the independent held-out answer key.

### Independent holdout and final gate

The separate evaluator selected different fields, froze its inputs, and ran the same main-queue and disk-reopen checks without modifying the renderer. PERSIST-HOLDOUT-01.v1 passed 3/3 repetitions (478 ms, 21 ms, 23 ms): pass-at-least-once 100%; pass-every-time 100%. It independently confirmed the fixed renderer hash above. Its setup, answer key, and run metadata are in [the separate holdout record](preferences-persistence-holdout.md), which the fixing agent did not inspect.

Evidence: `/tmp/otto-preferences-persistence-holdout-20261002.log`, SHA-256 `b76fd4c03bd145454b6d3cb43a8b693224b4029168a1b27c8c6ba55ca9bf86d7`.

The synthetic gate is green: frozen primary 3/3, independent holdout 3/3, related preference regressions 13/13, and renderer syntax/formatting checks pass. The packaging agent was released after the holdout passed. Native installed-app acceptance remains with the parent evaluation matrix; no synthetic result is counted as that acceptance.
