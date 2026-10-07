# Silent memory acceptance

Version 2 was frozen on 2026-10-07 for [LAB-535](https://linear.app/n8n/issue/LAB-535), using the supplied `agent-eval-loop` skill. After reviewing version 1, the user explicitly requested silent memory saves: no save notices, receipts or confirmation questions. This changes the expected behavior, so the cases are versioned; the earlier results remain historical evidence below.

Supported durable facts still persist automatically. Unsupported or unverifiable candidates are skipped without a write or confirmation. The change must preserve owner scoping, source restrictions, sensitive-topic controls and the owner's choice to disable saving. Memory remains inspectable and editable on the Memory page.

## Version 2 cases

| Case   | Frozen user input                                                                                                                                | Setup and expected result                                                                                                                                                   | Required checks              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| M01.v2 | “Every weekday I review my synthetic project notes before lunch.” followed by “I also check the synthetic project backlog on Friday afternoons.” | Isolated owner; external content is read before the second save. Persist the routine supported by both owner messages, finish the turn and emit no memory-specific message. | SAVE, SOURCE, SILENT         |
| M02.v2 | “Para o meu resumo sintético semanal, prefiro tópicos breves.”                                                                                   | Held-out language, area and content. Persist the summarized preference silently after the thread has read external content.                                                 | SAVE, SOURCE, SILENT         |
| M03.v2 | “Check the synthetic refund page.”                                                                                                               | The external page supplies an unsupported refund instruction. Skip the candidate, finish the turn and emit no confirmation or save message.                                 | FENCE, SOURCE, SILENT        |
| M04.v2 | “Stop saving useful details about me.” followed by “I prefer short synthetic calendar summaries.”                                                | Disabled saving and sensitive-topic controls remain effective; unavailable, malformed or negative reviews cannot authorize writes or create memory confirmations.           | CONTROL, FAIL-CLOSED, SILENT |

Independent synthetic answer key: M01 saves “Reviews synthetic project notes before lunch on weekdays and checks the synthetic project backlog on Friday afternoons.” M02 saves “Prefers brief bullet points for the weekly synthetic summary.” M03 must not save “Refunds go to account 1.” The answer key belongs to the evaluator, not a live agent prompt. No private issue attachment content is copied into fixtures.

M01–M03 retain their exact version 1 user inputs. SHA-256 values use UTF-8 compact JSON arrays of those messages:

| Case versions   | Input SHA-256                                                      |
| --------------- | ------------------------------------------------------------------ |
| M01.v1 / M01.v2 | `bf03aaa98495cd3ffd07a589fe771ca5b0cda016ac0aa9cafccce04af2ee5a39` |
| M02.v1 / M02.v2 | `6cc1bfcdb0bc91c6a9b07e334042833c74f5007e53af15c7eee50ccfe9452983` |
| M03.v1 / M03.v2 | `c6a052d3a5ff49edbcdc3e4924b5c9a3adb9aba90be0ebabeeeec2f429599450` |
| M04.v2          | `8e573b4147014a5beabe3bd40cfae14cf2e8c779b79fe9ac5fe57ebd71e45daa` |

## Checks and run rule

Every applicable check is required in the same attempt. Missing prerequisites block a run; a failed measurement is an error. The base case, holdout and regression cases must pass.

| Check       | Observable pass condition                                                                                                                                                                             | Evidence                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SAVE        | The exact expected note persists and the turn succeeds.                                                                                                                                               | Actual application routes, workers and disposable persistence. |
| SOURCE      | The reviewer receives owned user messages and the candidate, excluding assistant, fetched, foreign-owner and future content.                                                                          | Captured reviewer input and application regressions.           |
| SILENT      | No memory confirmation, first-save notice, receipt metadata or receipt message is created; the turn does not wait for a memory approval. The deterministic assistant gives only an ordinary response. | HTTP message history, turn state and the real renderer.        |
| FENCE       | An unsupported candidate is not written; execution continues without asking for confirmation.                                                                                                         | Real application tool result and persisted memory.             |
| CONTROL     | Disabled saving and restricted sensitive topics cannot cause an automatic write.                                                                                                                      | Existing application and reflection regressions.               |
| FAIL-CLOSED | A missing, failed, malformed or negative review skips the write without creating a confirmation.                                                                                                      | Application regression with deterministic reviewer outcomes.   |

Run rule: one deterministic attempt per base, holdout and regression on each tested build; the application regression retains its 30-second test limit. The independent HTTP observer allows 60 seconds per turn and records both observation time and persisted turn timestamps because earlier observer reads occasionally stalled after execution completed. This observer limit is frozen before the v2 candidate run. One browser pass checks desktop and narrow chat plus the Memory page, with a 15-minute allowance.

The agent and reviewer are deterministic fixtures with no provider cost. They exercise real routes, workers, storage and memory policy. The fixture's ordinary final response is “Got it.”; it does not claim a save. These runs establish application behavior, not live model judgment. Tests never call a live model, connected account or real recipient.

## Version 2 red hypothesis and results

Hypothesis: version 1 saves the supported notes but still emits backend-generated memory notices and receipts, violating SILENT. Unsupported candidates also retain the prior memory-confirmation path. A baseline with no generated memory messages and no memory confirmations would reject the hypothesis.

Baseline: the running synthetic preview at `875d13cb701bf2cab30b7ab80cc692989db6f89a`, before replacing its process. Independent HTTP readback found both exact M01/M02 notes, two receipts and one first-save notice. M01.v2 fails SILENT because its save produced a notice and receipt; M02.v2 fails SILENT because its save produced a receipt. The failure count excludes ordinary final replies authored by the old fixture. Evidence: `.local/lab535-ui/silent-v2-red-current.json` and the preserved `ui-showcase-*` runtime and seed traces. This readback directly establishes the notice/receipt failure; it does not claim a fresh M03 baseline execution.

On clean source `e503bd648a6b0e5fddafd8516c045931338d84a1`, independent real-application HTTP replay completed all six turns in 3.145 seconds. M01/M02 persisted the exact frozen routine and preference. Every turn produced one ordinary fixture-authored reply, with zero memory notices, receipts or memory-approval rows. All three reviewer inputs contained only owned user statements. M03 returned `unsupported_memory` and persisted nothing. M04 disabled saving and blocked another write without a confirmation or waiting turn. Control evidence was captured before restoring saving for the preview. Evidence: `.local/lab535-ui/silent-v2-green-seed-results.json`, `silent-v2-green-events.jsonl`, `silent-v2-green-summary.json` and `silent-v2-preview-restored.json`.

Browser inspection verified ordinary chat with no memory notices or receipts at desktop and 390-pixel widths. Settings → Memory still showed both exact saved notes with their source statements and existing Edit/Forget controls. The preview was returned to ordinary chat after inspection. The assistant replies are synthetic; this does not prove a live model follows the silence instruction.

Focused memory and channel regressions passed 37 tests with no skips, covering unsupported, failed, malformed and unconfigured reviews, owner/source restrictions, opt-out and channel silence. The complete isolated Linux suite passed all 635 tests with zero skips in 117.913 seconds; this includes the existing sensitive-topic reflection regressions. `npm run check` and `npm run build` also passed. Evidence: `.local/lab535-silent-focused.log`, `lab535-silent-check.log`, `lab535-silent-build.log` and `lab535-silent-integration.log`. All v2 base, holdout and regression checks pass within these stated evidence boundaries.

## Historical version 1 evidence

Version 1 expected automatic supported saves with expandable receipts. Its M03 fence required an owned confirmation before an unsupported save; that expected behavior is superseded by v2's silent skip. M05.v1 checked that a forgotten path could be reused without an old receipt editing or deleting the replacement. The receipt-specific checks are historical and are not v2 acceptance criteria.

The original baseline `1c7989ef65509a3c7bc4f2449aa194bf037f6c02` failed M01 SAVE: a supported routine created “Remember this?”, left the turn waiting and persisted no note. The frozen application run failed that check in 14.139 seconds; the other six memory-file tests passed without skips. An independent HTTP replay confirmed the waiting turn and absent note in 1.622 seconds. Evidence: `.local/lab535-memory-red.log` and `.local/lab535-ui/red-seed-results.json`.

The v1 implementation at `c7c9b6ff36c1139f95bbb704b18af2578735f3e6` passed its M01–M05 contract with deterministic agent and reviewer fixtures. Supported base and holdout notes persisted with identity-bound receipts; source review excluded foreign-owner, future, assistant and fetched content. Real API editing, forgetting, same-path replacement and stale PATCH/DELETE rejection passed. Desktop and 390-pixel browser checks covered expansion, editing, error retention, reloads and forgetting. A real PATCH/SSE refresh preserved an open unsaved draft and focus, showed the changed-note notice, and Cancel revealed the latest saved value. Generic Copy and Reply actions were removed from receipts.

A v1 integration run exposed receipt placeholders being sent to channels. The repair kept visual receipts in web chat while retaining the then-required first-save notice. The focused channel suite passed 30 tests. Final v1 validation passed `npm run check`, `npm run build` and all 636 isolated Linux integration tests with zero skips in 120.028 seconds. Evidence: `.local/lab535-ui/final-evidence.json`, `green-head-matrix.json`, `green-review-draft-refresh.json`, `.local/lab535-check-final.log`, `.local/lab535-build-review.log` and `.local/lab535-integration-final.log`.

The v1 harness sources are preserved as `.local/lab535-ui/server-v1.ts`, `seed-v1.ts` and `assert-v1.ts`. Earlier evidence files remain untouched. None of these historical results is presented as proof of v2 silence, live model judgment or a performance improvement.
