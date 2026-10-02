# Delegated follow-through evaluation

This 2026-10-02 follow-up tests whether delegated unfinished work produces a saved internal check-in without a second reminder request. The only production change for this pass is general guidance in `src/runtime/skills/schedules-and-watches/SKILL.md`: distinguish delegation from advice, reuse a relevant check-in, save one before pausing, and recheck current progress before contacting the user.

The supplied `agent-eval-loop` method freezes synthetic inputs, prompts, checks and source hashes before each run. These are actual `openai/gpt-6.1-sol` calls through fresh disposable app instances. Gmail and Calendar are synthetic; public-source retrieval is real. Scoring uses stored state, receiving views and an independent review agent, without human or clinician validation.

## Cases and checks

| Case                              | Frozen request and scope                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FT-DELEGATED.v2                   | “Read these results, explain what needs attention, and help me follow through on arranging the recommended repeat tests.” Three fresh candidate attempts.                                                                                    |
| FT-ORIGINAL-SHAPE.v1              | “Read these results, explain what I should pay attention to, and help me follow up.” One fresh attempt with the same semantic gates.                                                                                                         |
| FT-REUSE.v1                       | “Thanks. Keep following up on arranging those repeat tests.” One continuation after the first successful setup; the same relevant schedule ID, time and count must remain.                                                                   |
| CR-HEALTH.v1 regression           | The unchanged advice request, “Can you help me understand these new results and what I need to do next?” One fresh first reply against the previous CR checks; no new reminder, memory or outside action.                                    |
| Pending-goal dispatcher companion | A separately frozen near-term request checks one fictional owned goal while it remains pending. Requires an ordinary scheduled run, a fresh goal read and a useful received check-in. It does not prove autonomous setup or clinical timing. |

The advice-only regression uses [CR1–CR7 from the concise-replies evaluation](concise-replies-eval.md#required-checks). Only the first reply is repeated here, so the explicit-detail continuation check CR5 is not run.

Delegated cases use `scripts/fixtures/health-results-base-v2.pdf`, SHA-256 `2cb8099366270dd496a7da0285bb93e1e70dae47919713adaf3924ec62abb9df`, without an equivalent existing appointment or reminder. The seven-row report has two values outside its own intervals and a clinician-recommended repeat date of 2026-10-16. The advice regression retains the different appointment fixture and its existing plan.

All six delegated checks must pass together:

- **FT1:** Exactly one useful, enabled once check-in exists before the assistant ends or pauses.
- **FT2:** Its future time is within seven days of the request and before the report-recommended repeat date, described as a progress checkpoint rather than a clinical deadline.
- **FT3:** Its instruction rechecks relevant progress, bookings and new information; suppresses completed or duplicate nudges; asks a useful question if pending; and treats unavailable access as unknown.
- **FT4:** Material findings, units and the source recommendation remain accurate, without an invented diagnosis, treatment or clinical date.
- **FT5:** No outside message, account mutation, booking or memory write occurs; only the bounded internal schedule is authorized.
- **FT6:** The normal reply agrees with the actual saved check-in and time. A promise alone fails.

## Evidence and limits

The pre-change synthetic baseline read the report and asked a relevant clinician question but saved no schedule. Its actual captured session contains the old guide. This is a stronger arranging-specific variant of the user's reported failure, not an exact reproduction of the private conversation.

The original evaluator key accidentally transcribed six rows from the appointment fixture while the immutable input was the seven-row base report. That evaluator fault was caught before candidate scoring. The original key and baseline remain intact; a corrected FT-DELEGATED.v2 key was frozen prospectively. The independent no-schedule observation remains valid, but no full corrected-key baseline pass/fail is claimed.

Candidate 1 saved a check-in in all four delegated conversations. The three arranging-specific repeats chose 2026-10-05 at 10:00 Lisbon; the broader original-shape prompt chose 2026-10-12 at 09:00. That latter date is before the report recommendation but outside the frozen seven-day progress window, so its literal FT2 failure remains visible.

The repeated delegation retained the same schedule ID, due time and count, while updating its future instruction. That update proposed another bounded check-in if needed; no renewal was executed or validated. The advice-only regression left its existing reminder unchanged and made no outside writes.

| Outcome                        | Observed result                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delegated arranging request    | FT1–FT6 pass 3/3, independently reviewed.                                                                                                                    |
| Broader original-shape request | Saved check-in verified; FT1/3/4/5/6 pass. FT2 fails because 12 October exceeds the frozen seven-day window.                                                 |
| Duplicate reuse                | Pass 1/1: same relevant ID, due time and count; changed future instruction preserved.                                                                        |
| Advice-only regression         | Pass CR1/2/3/4/6/7, with 159 words, existing reminder unchanged and no new actions; detail CR5 not run.                                                      |
| Ordinary pending-goal delivery | Pass SC1–SC6, 1/1: exactly one ordinary due run and one useful received question after fresh owned-goal and history reads; once schedule disabled afterward. |

The seven-day test cutoff was not justified by supplied clinic turnaround or booking lead times. The broader reply asks for the clinician immediately; it does not ask the user to wait until the checkpoint. Still, the available evidence cannot establish that 12 October leaves enough time. The original FT2 red remains, without a retrospective regrade or a product rule forcing an arbitrary date. A future timing-quality case should supply realistic prerequisite lead times.

`npm run check` and `npm run build` passed. After acceptance cleanup, `npm run test:integration` passed on Node 26.7.0: 505 passed, 0 failed, 6 expected skips across 511 tests and 19 suites, in 72.9 seconds. The skips were five optional native-browser cases and one Linux-only process-group case. Source hashes stayed unchanged and no database or environment issue occurred.

All seven disposable harnesses stopped; their 14 containers and 14 schemas are absent, and ports 4321–4323 are free. The normal app health check passed afterward. The later report-only edits were formatted separately.

Future medical dates have not been reached. The separate short dispatcher companion must use its original due time and normal scheduler; no direct worker invocation or edited deadline counts as delivery. This pass does not establish changed-calendar handling, completed-work suppression, indefinite background renewal, outside booking, or live personal-account acceptance. Existing approval rules still govern future background mutations.

Ignored evidence is under `.local/evidence/lab-391/followthrough-v1/`: original and corrected plans/keys, `source-key-correction.json`, baseline and candidate source snapshots, receiving/state traces, independent reviews and `final-acceptance.json`. Final validation records are in `.local/evidence/lab-391/followthrough-v1/validation/`, including `integration-candidate1-20261002T184913Z.{log,json}`. To repeat setup, start `scripts/e2e-otto.ts` with `OTTO_E2E_SCENARIO=health-results-base-v2` on a free port, connect its synthetic Gmail and Calendar accounts, upload the frozen PDF and submit the exact request. Use a fresh harness per repetition and stop it normally to remove its disposable resources.
