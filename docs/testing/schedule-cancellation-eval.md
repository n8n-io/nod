# Schedule cancellation evaluation

Source: [LAB-549](https://linear.app/n8n/issue/LAB-549). Frozen on 2026-10-08 against `7c097be7` using the supplied agent-eval-loop method. Private diagnostic content stays outside the repository; all fixtures use synthetic schedules and messages.

The report shows cancellation requests followed by repeated schedule-pause confirmations. Current main already permits ordinary conversation schedule changes and separates background history from active chat. This evaluation targets the remaining authority and duplicate-confirmation paths.

## Frozen cases

| Case                 | User task and setup                                                                                                                                 | Required outcome                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CANCEL-RESUME.v1     | Ask to stop a synthetic recurring check while a confirmed foreground continuation is active. Deliver the new owner message through normal steering. | The existing schedule becomes disabled, its next job is cancelled, and no second confirmation is created. The saved action identifies the actual cancellation message.         |
| CANCEL-REVISION.v1   | Ask to cancel a schedule after a background run has proposed pausing it.                                                                            | The new owner request disables the schedule directly and supersedes the addressed proposal.                                                                                    |
| CANCEL-DUPLICATE.v1  | Two background runs propose the same schedule pause before the owner replies.                                                                       | One pending action and one visible confirmation; neither run disables the schedule without the owner.                                                                          |
| CANCEL-BOUNDARIES.v1 | Change source ownership, thread, turn or role; retain the original confirmation reply; vary the action or arguments and pending state.              | Unrelated messages and the original Yes never become fresh authority. Read-only work stays read-only. Distinct actions and later handled/expired proposals remain independent. |

## Checks and run rule

Each applicable check must pass in the same run. Exact database state, queue state and action counts are scored by code in the existing approval test files. No model judge is used.

| Check | Applies when                            | Pass condition                                                           | Evidence                                                          |
| ----- | --------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| C1    | A fresh owner cancellation is consumed  | Schedule is disabled and the saved next job is cancelled                 | Application fixture, schedules and pg-boss tables                 |
| C2    | Cancellation executes                   | Its source message is the consumed owner message                         | Persisted approval row                                            |
| C3    | A direct cancellation is requested      | No extra pending approval is created                                     | Persisted approvals and assistant messages                        |
| C4    | Equivalent background proposals overlap | Only one pending proposal and question exist; execution has not occurred | Concurrent database-backed approval requests                      |
| C5    | A boundary variant is supplied          | No unauthorized execution occurs                                         | Approval ownership, read-only, exact-action and replay assertions |

Environment: Node 26, PostgreSQL 17 with disposable schemas, synthetic agent adapter and fake external providers. Repeat the focused suite three times after the fix. Run the full Linux integration suite, type/architecture/format checks and production build once on the final implementation. Preserve baseline logs and input hashes under ignored `.local/evidence/lab-549/`.

These controlled application cases exercise the real HTTP, worker, runtime tool, approval and scheduler paths. They do not measure autonomous model interpretation, live connected accounts, or the original private session. Repository rules prohibit live model/account calls from tests.

## Hypotheses recorded before implementation

- H1: Approval creation drops the runtime's latest user-message provenance, so a steered cancellation inherits the resumed turn's older authority. Expect an unnecessary confirmation or direct-request error and no disabled schedule. A correctly attributed, direct cancellation on the baseline would disprove this.
- H2: Revision handling forces another review even for the owner's reversible schedule change. Expect a replacement pending approval instead of a disabled schedule. Direct completion on the baseline would disprove this.
- H3: Background deduplication searches only one turn's ancestry. Expect concurrent independent turns to create duplicate pending questions. A single shared pending action on the baseline would disprove this.

## Attachment follow-up

The attachment contains 13 pause-confirmation messages. The three captured `schedule_cancel` calls report tool success while returning a confirmation request. Both captured `schedule_list` results already show the target recurring schedule disabled with no next run. This establishes repeated unnecessary confirmation even after the schedule was paused; the attachment does not establish which earlier action paused it.

Before changing this path, add CANCEL-PAUSED.v1: a background event calls `schedule_cancel` for an already-disabled synthetic schedule. C6 requires the event to finish successfully with no new approval, confirmation message, schedule revision or queued job. Score real application and database state. H4 predicts the unchanged implementation creates a pending confirmation despite having no state change to perform; a successful unchanged read would disprove it. This is an added case, not a regrade of the original cases.

## Results

Pending the frozen baseline and candidate runs.
