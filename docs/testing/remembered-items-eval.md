# Remembered items acceptance

Frozen on 2026-10-07 for [LAB-535](https://linear.app/n8n/issue/LAB-535), using the supplied `agent-eval-loop` skill. The reported failure is a routine memory save stopping the conversation with “Remember this?”. The expected result is an automatic save with a compact, expandable receipt that lets the owner inspect, edit and forget the saved note.

## Cases

| Case   | Frozen user input                                                                                                                                | Setup and expected result                                                                                                              | Checks                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| M01.v1 | “Every weekday I review my synthetic project notes before lunch.” followed by “I also check the synthetic project backlog on Friday afternoons.” | Isolated owner, external content already read. Save the routine supported by both messages without a confirmation.                     | SAVE, SOURCE, RECEIPT, EDIT, FORGET |
| M02.v1 | “Para o meu resumo sintético semanal, prefiro tópicos breves.”                                                                                   | Held-out language, area and content. Save the summarized preference without a confirmation after reading external content.             | SAVE, SOURCE, RECEIPT               |
| M03.v1 | “Check the synthetic refund page.”                                                                                                               | The external page supplies an unsupported refund instruction. No memory write occurs until the owner confirms the exact proposed note. | FENCE, SOURCE                       |
| M04.v1 | Stop saving, then share another lasting preference.                                                                                              | Existing opt-out and sensitive-topic boundaries remain in force; an unavailable or invalid review cannot authorize a save.             | CONTROL, FAIL-CLOSED                |

Independent synthetic answer key: M01 saves “Reviews synthetic project notes before lunch on weekdays and checks the synthetic project backlog on Friday afternoons.” M02 saves “Prefers brief bullet points for the weekly synthetic summary.” The answer key belongs to the evaluator, not a live agent prompt. No private issue attachment content is copied into fixtures.

M05.v1 was added before its first run after independent review found that paths can be reused: forget a synthetic note, create a different note at the same path, then attempt to edit and delete through the old receipt. REUSE requires the old receipt to stay inactive and stale mutations to return 409 without changing the replacement. Evidence: real memory routes and stable persisted note identities; code. This adds a lifecycle regression without changing M01–M04 checks.

## Checks and run rule

Each named check is required. A case passes only if all applicable checks pass in the same attempt. Missing prerequisites block the run; measurement failure is an error. Base and holdout must both pass.

| Check       | Applies when                                          | Observable pass condition                                                                      | Evidence and method                                          |
| ----------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| SAVE        | Owner states a durable routine or preference          | Exact expected note persists and turn finishes without a memory confirmation                   | Real application, disposable database and object store; code |
| SOURCE      | A proposed note is reviewed                           | Reviewer receives owned user messages and candidate only, with no assistant or fetched content | Captured review input; code                                  |
| RECEIPT     | A note save succeeds                                  | Chat contains one expandable receipt for the source message and reveals the current saved note | API metadata and real renderer; code/manual                  |
| EDIT        | Owner edits a receipt                                 | Saved value changes through the real API and remains changed after reload                      | Browser and subsequent GET; manual/code                      |
| FORGET      | Owner forgets a receipt note                          | Note disappears from current memory and the receipt no longer presents it as remembered        | Browser, subsequent GET and reload; manual/code              |
| FENCE       | Candidate is not supported by owner statements        | Save waits for exact owned confirmation, with no pre-confirmation memory write                 | Existing application approval regression; code               |
| CONTROL     | Saving is disabled or sensitive topics are restricted | Disallowed automatic saving remains blocked                                                    | Existing memory application and reflection regressions; code |
| FAIL-CLOSED | Reviewer errors or returns malformed/negative result  | No review-based automatic save                                                                 | Application regression; code                                 |

Run rule: one deterministic attempt per base, holdout and regression on each tested build, 30-second application-test limit; one browser pass at desktop and narrow widths, up to 15 minutes. Model is a deterministic fixture, with no provider cost. The application tests use real routes, workers, storage and approval logic; they establish the enforcement contract, not the quality of a live model's judgment. UI runs use that same isolated application with synthetic data. Live agent acceptance remains separate and is not run because the repository forbids tests calling live models or connected accounts.

## Red hypothesis

The thread's persistent outside-content marker routes every summarized `memory_save` through approval except one narrow explicit remember request. Expected trace: a supported routine reaches `OTTO_memory_save`, creates a pending approval and leaves the turn waiting. Evidence that would reject this hypothesis: the same routine saves automatically on the baseline without a pending confirmation.

The general fix is an owner-message-only review of proposed memory and a receipt tied to stable note identities and saved paths. It must not grant permission for external actions, trust fetched content, silently approve uncertain memory, or store another permanent copy of forgotten note text in receipt metadata.

## Results

Baseline: `1c7989ef65509a3c7bc4f2449aa194bf037f6c02`. The frozen red application run failed M01 SAVE: the turn did not reach `succeeded` within the frozen timeout. The baseline routing code sends this supported routine through memory approval. The other six tests in the memory file passed; none were skipped. Duration: 14.139 seconds. Local trace: `.local/lab535-memory-red.log` (synthetic data only).

Input SHA-256 values use UTF-8 compact JSON arrays of the exact user messages above:

| Case   | Input SHA-256                                                      |
| ------ | ------------------------------------------------------------------ |
| M01.v1 | `bf03aaa98495cd3ffd07a589fe771ca5b0cda016ac0aa9cafccce04af2ee5a39` |
| M02.v1 | `6cc1bfcdb0bc91c6a9b07e334042833c74f5007e53af15c7eee50ccfe9452983` |
| M03.v1 | `c6a052d3a5ff49edbcdc3e4924b5c9a3adb9aba90be0ebabeeeec2f429599450` |

Independent HTTP replay on the baseline confirmed M01's second turn was `waiting`, an exact “Remember this?” prompt was present, and no note had persisted (1.622 seconds). The first green HTTP replay finished all three M01/M02 turns, persisted both exact expected notes and two receipts, and excluded fetched and assistant content from both reviewer inputs (2.040 seconds). Local evidence: `.local/lab535-ui/red-seed-results.json`, `green-seed-results.json`, `red-events.jsonl`, `green-events.jsonl`, and `summary.json`.

The initial browser pass verified keyboard expansion, editing and persistence after reload. Final identity-fenced, lifecycle, regression and browser results are pending.
