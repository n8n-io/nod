# Code mode output evaluation

This is a synthetic contract evaluation using the actual Pi 1.0 code mode implementation. It does not claim live model or installed-app task acceptance.

## Frozen case: CODE-OUTPUT-01.v1

Prompt: “Keep the full result so you can read the remaining lines.”

Setup: Pi 1.0 executes a deterministic script returning 5,000 synthetic text lines. Its temporary directory, session and workspace are disposable. Workspace writes use the existing sandbox write implementation against a real disposable directory. The fixture replaces provider inference; no network, model, real account or normal app profile is used. One repetition per attempt, 20-second deadline, Node 26.7.0 on macOS. Base commit: `f187ac8911beba6d091d54b3274312c67f13ef81` plus the desktop working-tree changes.

| Check   | Applies when                                 | Pass condition                                                                                 | Evidence                                             |
| ------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| CODE-C1 | Actual SDK output exceeds its inline budget. | The returned path is inside the owned workspace and its bytes equal the full generated result. | Actual file read; code assertion.                    |
| CODE-C2 | The guarded callback completes.              | Guard-visible content and metadata contain only the workspace output path.                     | Captured result before guard return; code assertion. |
| CODE-C3 | The output is transferred.                   | The SDK temporary directory contains no remaining overflow file.                               | Directory inventory; code assertion.                 |

The case passes only when all checks pass in one run. The final gate additionally requires independently selected oversized output and guard/cleanup failure cases, related Pi regressions and an Electron utility-process worker/WASM smoke.

## Hypothesis before the fix

The Pi wrapper returns SDK overflow results unchanged. The SDK creates `pi-codemode-<random>.txt` in the host temporary directory and advertises that path, while Otto's read/write tools operate inside its workspace. Predicted red: full bytes exist only in the SDK temp directory; the guard sees a host path; the SDK file remains. This is disproved if the original wrapper already moves the complete output to the workspace and cleans the SDK file before returning the guarded result.

The intended general fix transfers only a validated, bounded, regular SDK overflow file through the existing workspace writer inside the existing tool guard, rewrites the result path and removes the SDK file. It does not permit arbitrary host-file reads.

## Attempts

The frozen red run failed all three checks: guard-visible path remained on the host, no full workspace output existed, and the SDK temporary file remained. This confirms the application integration gap. Evidence: `.local/codemode-output-red.log`, SHA-256 `57793aace67fcfd56a454b54f17f1090a6258c0bd1e10902cbae30e38e92e902`; one failing run, 241 ms case time and 2,205 ms harness time. No model or external request; cost unavailable.

Before-fix SHA-256: Pi provider `323bd23deeb8c7f91a0725c46173cf0cae456a9c72a795f64c433bbe32e7fddb`; test file `2bcbab00e17b35e0270613f0cea496b13f481c17c925396162df8bca6c0d5510`. The first fixed-source run retained the v1 prompt, generated text, checks and repetition count; its cleanup measurement was rejected as described below.

### Evaluator correction: CODE-OUTPUT-01.v2

The first fixed-source run passed workspace readability and guard-visible path checks, but the cleanup assertion also counted the unrelated `jiti` cache directory. `.local/codemode-output-cleanup-inventory.log` records that sole remaining entry. Version 2 keeps the task, bytes, setup and other checks unchanged and measures CODE-C3 against SDK overflow filenames only, matching its stated subject. The original red and first fixed-source result are retained. Version 2 is rerun against the preserved isolated pre-fix engine before accepting green.

## General fix and current results

The Pi wrapper now validates the SDK's exact temporary filename and directory, opens without following symlinks, accepts only a regular file owned by the current user with one link, and bounds it to 16 MiB. It copies the complete text through the existing workspace write implementation inside the guarded callback, rewrites content and metadata to the workspace path, and removes the SDK file before returning. Transfer and cleanup failures return a bounded error. Other tool results are unchanged.

Fixed provider SHA-256: `31cdb050715d8ea217eff62bb16d64c913993562255c9f78e340a380fd2eb8b8`. Exact prompt SHA-256: `793edf3e4cbec73c26f50c4d45e1b59bea924205a6475908d3c5586914eb9206`. Frozen formatted test-block SHA-256: `08d8e94d244fa75cdd1e005398fcb745a5ff0494e560d9252bd64abdfb83a538`; formatting changed no setup, data or checks.

| Attempt                                | Result                                                                                                                                                                                                                                                                                                              | Evidence                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CODE-OUTPUT-01.v2 red                  | All three checks fail against the preserved pre-fix isolated engine. 205 ms case, 1,211 ms harness.                                                                                                                                                                                                                 | `.local/codemode-output-v2-red.log`, SHA-256 `fb047089145cb2bee002470464ef15c3d1d97c680f633873c300b2239f2d520f`. Log written 2026-10-02T09:56:06.015Z.                                   |
| CODE-OUTPUT-01.v2 green                | All three checks pass; the related nested-call visibility/guard test also passes, 2/2 total. 113 ms case, 2,617 ms harness.                                                                                                                                                                                         | `.local/codemode-output-v2-green.log`, SHA-256 `ca4cb740374c3cb6decfa371886f2a15c3b7527508866db5377f787c02f81d54`. Log interval 2026-10-02T09:56:17.823Z–09:56:20.464Z.                  |
| Related Pi and agent guard regressions | 57/57 pass, 6,914 ms.                                                                                                                                                                                                                                                                                               | `.local/pi1-codemode-related.log`, SHA-256 `6df29435e752d74860cf637a3fa5402f2c76116a5e71660618014e40dfb1a63a`. Log interval 2026-10-02T09:56:54.392Z–09:57:01.334Z.                      |
| Actual Electron utility-process smoke  | Pass with Electron 44.5.0, embedded Node 24.21.0 and Pi 1.0.0. Executed QuickJS worker/WASM from the pruned engine copied outside repository ancestry; verified guarded workspace/web-cache calls, sensitive-tool exclusion, absent process/network/timer/model globals, and the actual SDK overflow transfer case. | `.local/pi1-electron-smoke-fixed.log`, SHA-256 `946921c642dba9a83b9092c9c61a61cb85c4fd52bb9853a8d2814f45c0e3ee81`. Written 2026-10-02T09:56:56.216Z; exact run times are inside the log. |

The Electron probe used no window, VM, normal app profile, provider inference or external request; its provider stream and workspace inputs were synthetic. An earlier probe error was a harness use of CommonJS resolution for an import-only package; correcting the harness to use normal ESM imports passed before the source fix. TypeScript and diff whitespace checks pass. No monetary model cost occurred; usage accounting is unavailable. Log intervals above are filesystem creation and modification times, except exact timestamps recorded by the Electron runner.

### Final source

The final helper also opens nonblocking so a non-regular file such as a FIFO is rejected by the regular-file check without blocking the process. Final provider SHA-256: `14917b57d54c744d36308482a1f37127bdd257a9f5c30df17ae0be9912eeffff`.

Final source passed the actual Electron utility-process smoke again, including the overflow transfer: `.local/pi1-electron-smoke-final.log`, SHA-256 `559636159d43020cc6f5d0eaa65bb0a6741601601edde7366928300da06908de`. The combined Pi and agent-guard suite, including the independent evaluator's appended cases, passed 67/67 in 8,470 ms: `.local/pi1-codemode-related-final.log`, SHA-256 `7fa88b0df91acc9eb117c65b468368139223b0d72258dd1657cd1b626b6585bd`. TypeScript also passed. The fixing agent did not inspect the held-out inputs or answer key.

The independent evaluator used a separate overflow/guard-failure/cleanup-failure scenario set, rather than repetitions of CODE-C1–C3 alone. Its own four-check gate covered those scenarios and reported nine repetitions passing on this final hash, with zero model calls. Evidence: `.local/desktop-evals/evidence/codemode-output-holdout-v1-attempt2.json` and `.log`; log SHA-256 `8112eb7bf4c4170fa87459415370b89652b9516980b653f2d2812d8b929a6f29`. Its first attempt is retained separately. The fixing agent did not inspect either answer key.

The synthetic gate is green: preserved red, fixed primary, independent failure/overflow holdouts, related regressions and real Electron utility-process worker/WASM execution all pass. Packaging is released for this source hash. Root-owned installed-app, live task and final whole-repository checks remain separate evidence.
