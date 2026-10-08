# Completed task reuse acceptance

Frozen on 2026-10-08 with the supplied agent-eval-loop skill for [LAB-559](https://linear.app/n8n/issue/LAB-559). The source baseline is `d783d5ac622ef2f93cec9248cd7993bbaa3bde33`.

The attached diagnostic report records a browser handoff, a fresh snapshot, a successful `browser_session save` with `signedIn: true`, and `task finish` with `status: done`. The final reply contains neither a Vault link nor a scheduling offer. Saving browser state does not create a Vault login, and the completed task card has no scheduling action. The report is truncated; it is historical evidence of this sequence, not a fresh verification of the external outcome. Private report contents are excluded from this repository.

## Frozen cases

These cases exercise the actual renderer with synthetic APIs, and the actual server contracts with disposable PostgreSQL schemas. No live model, connected account or real recipient is used. Each case has a frozen definition and a ten-minute limit. All attempts, including retries after automation faults, are retained below. Every applicable named check must pass in the same attempt.

| Case   | User task                                                        | Setup and expected result                                                                                               | Checks                                    |
| ------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| VR1.v1 | Save the login I used in the browser for next time.              | Inline browser handoff; explicitly open a secure new-login form and submit synthetic login details.                     | OFFER, SECURE, SAVE, HANDOFF              |
| VR2.v1 | Save this other account without changing the first one.          | Different synthetic account; cancel, reopen, save; invalid deep links cannot prefill or carry secrets.                  | SECURE, SAVE, CANCEL, LINKS               |
| SR1.v1 | Run this completed task every weekday at 09:00 in Europe/Lisbon. | Owned completed task; editable original instructions; explicit creation with chosen timing; original task remains done. | CONTEXT, TIMING, CREATE, ORIGINAL         |
| SR2.v1 | Schedule the other task with the same title for Monday at 14:30. | Another owned completed task with a clarification; cancel first, then create.                                           | CONTEXT, TIMING, CREATE, CANCEL, ORIGINAL |
| SR3.v1 | Open a schedule draft for this task.                             | Foreign-owner, unfinished and cancelled tasks; read-only request.                                                       | OWNER, ELIGIBLE                           |

## Checks

| Check    | Applies when                      | Observable pass condition                                                                                                                            | Evidence and method                      |
| -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| OFFER    | Inline browser is shown           | A direct action opens the secure new-login form.                                                                                                     | Actual renderer; browser review          |
| SECURE   | Login form is opened or submitted | Secrets use the existing Vault POST only, never chat, URL or storage; sensitive fields clear on submission/unmount.                                  | Mounted form and Vault integration; code |
| SAVE     | Login is explicitly saved         | Exactly one owned Vault entry is created with the submitted details.                                                                                 | Vault integration; code                  |
| HANDOFF  | Vault opens from inline browser   | Original browser handoff remains available.                                                                                                          | Browser review                           |
| LINKS    | A new-login deep link is supplied | Only the exact supported local route/query is accepted; extra parameters, fragments and foreign navigation are not treated as setup links.           | URL guard regression; code               |
| CONTEXT  | Draft opens for a completed task  | Draft contains its owned original instructions and clarifications, excludes assistant-generated authority and unrelated tasks, and remains editable. | Server integration and browser review    |
| TIMING   | Schedule is submitted             | Saved recurrence, time and time zone match the explicit selection.                                                                                   | Schedule integration and browser review  |
| CREATE   | User confirms creation            | One schedule is created; opening the draft neither executes the task nor creates a schedule.                                                         | Request trace and integration; code      |
| CANCEL   | User cancels                      | No Vault entry or schedule is created.                                                                                                               | Request trace; code/browser review       |
| ORIGINAL | Schedule creation succeeds        | Original task remains done and unchanged.                                                                                                            | Server integration; code                 |
| OWNER    | Task belongs to another owner     | Draft request returns no private task content.                                                                                                       | Server integration; code                 |
| ELIGIBLE | Task is unfinished or cancelled   | No promotion is available and server refuses the draft.                                                                                              | Server integration and browser review    |

## Red hypotheses

- VR1/OFFER: the handoff has only browser controls and Done; a new secure-form link should make saving available without adding credential capture. Reject this hypothesis if baseline already exposes that flow.
- SR1/CREATE: completed cards have no promotion action or owned draft endpoint. Reusing the original owner instructions through the existing schedule endpoint should preserve context and avoid replaying the task immediately. Reject this hypothesis if baseline already exposes a complete promotion flow.

The optional agent-written Vault offer is a prompt policy change. Deterministic UI/server checks do not establish its live-model reliability. Live authentication and real scheduled delivery are outside these fixture results.

## Attempts

The sanitized [evidence index](task-reuse-evidence.json) records source, fixture, log, receipt and screenshot SHA-256 hashes. Raw artifacts remain in ignored `.local/debug/lab-559/`. Original baseline `d783d5a` is retained. Implementation `2b0f71a` was rebased onto `a5b2fdc2`; the five listed feature-source hashes match static bundle v3. That bundle predates the rebase; API/auth compatibility is checked separately by audit and integration tests.

| Attempt                                  | Result                      | Evidence and interpretation                                                                                                                                                                    |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original renderer, fixture v1            | Red                         | `handoff-before.jpg` has no Save login action; `tasks-before.jpg` has no scheduling action.                                                                                                    |
| Original Vault contracts                 | Red                         | `vault-red.log`: 2 failed, 1 passed. The new link was rejected and the secure form did not open.                                                                                               |
| Original schedule contracts and renderer | Red                         | `schedule-red.log`: 5 failed, 16 passed; draft endpoint absent. `schedule-ui-red.log`: scheduling action absent.                                                                               |
| Uncertain-save regression                | Red, then green             | `schedule-uncertain-red.log` retains the failure before the guard. `schedule-green.log` verifies ambiguous responses block resubmission and offer View schedules.                              |
| Development fixture loading              | Unusable                    | Repeated reloads prevented stable inspection. Acceptance continued with a compiled static bundle; this was a fixture failure.                                                                  |
| VR1 + VR2, static v2                     | Passed in synthetic browser | Save login opened an empty secure form while the handoff remained available. Explicit saves retained two separate synthetic accounts; cancel created nothing. Vault source is unchanged in v3. |
| SR1, static v2                           | Passed in synthetic browser | One create with `0 9 * * 1-5`, `Europe/Lisbon`, and the original base instructions.                                                                                                            |
| SR2, static v2, attempt 1                | Failed automation attempt   | Fill changed the DOM time without updating React state. The request remained `0 9 * * 1`, failing 14:30. The failed receipt is retained.                                                       |
| SR2, static v2, attempt 2                | Passed in synthetic browser | Native keyboard entry confirmed 14:30; request was `30 14 * * 1`. No production code or check changed between attempts.                                                                        |
| SR1 + SR2, clean static v3               | Passed in synthetic browser | Exactly two creates: weekdays at 09:00 and Monday at 14:30 in Lisbon. Cancel/reopen wrote nothing; the same-title holdout retained its distinct request and clarification.                     |
| Focused server and mounted renderer      | Passed                      | Vault focused 3/3, Vault and guards 67/67, schedules 22/22; no skips. Separate tests verify ownership, encrypted persistence, exact recurrence, and duplicate/uncertain-save protection.       |

Final browser artifacts are the paired `handoff-before-final.jpg` / `handoff-after-final.jpg`, `schedule-draft-final.jpg` and `schedules-final.jpg`. The earlier `handoff-after.jpg` is retained but its toolbar is below the viewport, so it is not Save login proof. The earlier `schedule-draft.jpg` is blank and excluded from passing proof. Screenshot **Next** times are fixed fixture placeholders, so they do not verify real next occurrences. Request receipts verify selected recurrence; disposable-database tests verify occurrence calculation and dispatch contracts.

Before the rebase, `npm run check`, `npm run test:integration` and `npm run build` exited 0. Integration passed 719 tests, with zero failures, skips, cancellations or TODOs. After rebasing onto `a5b2fdc2`, all three commands also exited 0: 723 integration tests passed with zero failures, skips, cancellations or TODOs. Earlier failures remain in the record.

These results establish synthetic renderer behavior and local integration contracts. They do not establish live-model offer reliability, real account authentication, or delivery to a real recipient.

## PR verification

Static v4 was rebuilt from PR head `f19f5e4e`, including the rebased API/auth code, with unchanged fixture inputs. Browser checks passed for both schedule cases, two separate Vault accounts, cancellation and handoff continuity. The final task session created exactly two schedules (`0 9 * * 1-5` and `30 14 * * 1`, Europe/Lisbon) with the distinct original prompts; the Vault session created exactly two entries. The local snapshot `.local/debug/lab-559/final-head-evidence.json` has SHA-256 `c4d5459648f5b7ccf09286b89809ecb2042c03c71e19c8a399e1053469aaf8e7`. An earlier reload raced the bundle replacement and still loaded v3; its `schedules-v4.jpg` is retained but excluded from v4 proof.

PR review identified URL-embedded credentials missing from draft screening, app-relative Vault links being offered in messaging channels, an unhandled derived promise in the Vault test, and the ambiguous retry description above. The first CI attempt also exposed an inherited eval transport mismatch after the latest main merged. Those attempts remain part of the record; subsequent verification is recorded on the PR.
