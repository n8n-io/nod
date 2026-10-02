# Concise replies evaluation

The 2026-10-02 user feedback identified an overly long first explanation despite existing brevity guidance. This follow-up uses the supplied `agent-eval-loop` method to test concise initial answers and complete explanations on request. Private reports are excluded from fixtures and evaluator inputs.

Final candidate 5 passed the applicable checks in three health first replies, one revised Atlas exchange and one untouched Workshop exchange. Requested detail passed in the first health run and both neutral cases. These are small controlled acceptance samples; all earlier failures remain recorded.

## Change

`src/runtime/personality.ts` asks for a concise first answer with the conclusion, actionable findings and next step, then a specific offer of more detail. Requested explanations and deliverables remain complete; urgent guidance, material uncertainty and source support stay visible. `src/runtime/prompt.ts` repeats a brief delivery cue alongside conversation requests and user steering. It leaves the original user instruction unchanged and does not add that cue to background or activity-check envelopes.

The default supported OpenAI Responses model uses `text.verbosity: low`, which OpenAI documents as its [default-detail control](https://developers.openai.com/api/docs/guides/deployment-checklist#set-up-textverbosity). Custom models and other providers keep their settings. The adapter clones model metadata and preserves other sampling/text fields. There is no output-token cutoff, response truncation, health-specific template or fixture branch. The soft 120-word preference is guidance with exceptions for requested depth and essential safety or accuracy.

Earlier wording, instruction placement and provider verbosity alone did not satisfy the interaction checks. The placement change was reverted. The final candidate combines the general style guidance and native verbosity with a conversation-level delivery cue; the evaluation does not attribute the result to one component in isolation.

## Frozen cases

The base commit is `b5cbdfda8687d6a43ba0c884a07e731535eb6ed2`, with the earlier health-follow-up changes retained. Each candidate manifest records source hashes and the dirty diff. Runs make actual `openai/gpt-6.1-sol` calls through the app, using fresh disposable schemas and Pi conversations, fictional inputs and synthetic integrations. Public-source retrieval is real; connected accounts and recipients are synthetic. Each turn has a ten-minute limit.

| Case            | First request                                                            | Detail continuation                                                                                                                                                           | Repetitions                                                                                    |
| --------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| CR-HEALTH.v1    | Can you help me understand these new results and what I need to do next? | Please show me the detailed breakdown of the results, including the values, units and report ranges, what they may mean, and how they fit with the follow-up already planned. | One baseline exchange; three candidate first answers, with a detail continuation on the first. |
| CR-NONHEALTH.v1 | What do I need to know from the attached project note?                   | Give me the detailed rollout plan, including the remaining work, owners, dates, and what happens if the review is not finished.                                               | One candidate exchange, independently authored before candidate runs.                          |
| CR-NONHEALTH.v2 | Same exact request as v1.                                                | Same exact continuation as v1.                                                                                                                                                | One fresh exchange after the evaluator correction; unchanged candidate 5.                      |
| CR-WORKSHOP.v1  | What do I need to know from this workshop note?                          | Give me the full preparation plan: who is doing what, the deadlines, how the session will run, and what happens if the open issues are not resolved.                          | One final exchange, authored and frozen after production tuning stopped.                       |

Health input: `scripts/fixtures/health-results-appointment-v2.pdf`, SHA-256 `109980dec3d0cc556dc97d90d54596b0cdb96d682414c47f35a74d588c66949f`, with its existing fictional profile, appointment and reminder. The first reply must distinguish the two abnormal findings from diagnosis, use the existing review, and avoid claiming the recommended repeat test is booked. The detailed reply must accurately cover all six measurements and their units and intervals.

Atlas input: `scripts/fixtures/atlas-documentation-handover.md`, SHA-256 `1e3cf1367ca15f187be94256dfbba57f4d3e16afa2f926842a7e54dd9bb4b64b`. The first reply must distinguish the approved internal desktop pilot from the blocked public/mobile release and unknown review outcome. Requested detail includes remaining work, ownership, dates and conditional fallback. Atlas was reused during development; it is a cross-domain regression case, not the untouched final holdout.

Workshop input: `scripts/fixtures/willow-workshop-readiness.txt`, SHA-256 `ce7ece7b15e994766c0525198f148ca4f704270fdf5dd2bfdb713b54b533a942`. This new case distinguishes unconfirmed room access, which blocks the workshop, from a guide defect with a working demonstration fallback. Its source, prompts and key were frozen before the only run and were not used for further tuning. Decision, action and uncertainty are required; optional background inventory is not.

## Required checks

| Check | Pass condition                                                                                                                                                                     | Evidence                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| CR1   | First-turn visible assistant text is at most 180 words, excluding Markdown link destinations, with an immediately clear conclusion and next step. The count alone is insufficient. | Code count and independent review agent.                               |
| CR2   | The first answer selects decision-relevant findings and existing context without an unsolicited exhaustive breakdown or repeated summary.                                          | Source/key comparison and independent review agent.                    |
| CR3   | Claims and quoted measurements remain accurate, qualified and source-supported.                                                                                                    | Values, units, ranges, trace and checked sources.                      |
| CR4   | A brief, specific offer makes deeper detail available without withholding the answer.                                                                                              | Receiving view and independent review agent.                           |
| CR5   | An explicit detail request receives a complete, navigable breakdown. No short-answer word cap applies.                                                                             | Full exchange and source/key comparison; applies only to detail turns. |
| CR6   | No unauthorized account mutation, reminder, memory save or outside message occurs. Existing plans stay unchanged.                                                                  | Stored state and action trace before and after.                        |
| CR7   | Relevant sources are identifiable and claimed actions match actual state.                                                                                                          | Normal receiving view, trace and stored state.                         |

All applicable checks must pass together. Repeat counts and checks are frozen before dispatch in ignored `.local/evidence/lab-391/concise-replies-v1/plan.json`; answer keys remain outside the agent context. The 180-word threshold is specific to these bounded first-answer cases, not a product limit. These are code and model-assisted acceptance checks, without human or clinician sign-off.

## Running the cases

Start `scripts/e2e-otto.ts` with Node 24.21 or newer and `OTTO_E2E_SCENARIO=health-results-appointment-v2` on a free port. Connect only its synthetic Gmail and Calendar accounts, upload the frozen PDF through normal chat, and submit the exact first request. Submit the detail request in the same conversation. Use a fresh harness for each repetition.

For either neutral note, use a fresh harness with no app connections and upload only the source file: Markdown for Atlas or plain text for Workshop. Record source and prompt hashes, actual captured system prompts, received messages, Inspector usage and before/after state. The operator evidence endpoint supports receiving and mutation checks. Stop each harness normally to clean up its disposable resources; never reset the normal local database.

## Results

The original user-observed verbosity failure is retained separately as private metadata. A fresh synthetic baseline independently reproduced it.

| Attempt                                | First-turn words | Result                                                                                |
| -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| Baseline health                        | 297              | Fail CR1, CR2 and CR4: long, exhaustive and no offered detail path.                   |
| Candidate 1 health                     | 294 / 239 / 222  | All three fail the same checks despite confirmed new instructions.                    |
| Candidate 1 nonhealth                  | 237              | Same failure on the independently authored project note.                              |
| Candidate 2 health                     | 290 / 287 / 246  | All three fail despite the soft length target.                                        |
| Candidate 2 nonhealth                  | 204              | Same exhaustive first-answer selection; no detail offer.                              |
| Candidate 3 nonhealth                  | 246              | Placement alone fails; conditional health runs not started.                           |
| Candidate 4 nonhealth                  | 189              | Native low verbosity alone fails; conditional health runs not started.                |
| Candidate 5 nonhealth, original v1 key | 128              | CR1/3/4/5/6/7 pass. Literal CR2 key-completeness miss retained; see correction below. |
| Candidate 5 Atlas, prospective v2 key  | 129              | Pass 1/1 exchange; requested detail 426 words.                                        |
| Candidate 5 health, unchanged v1 key   | 132 / 148 / 142  | Pass 3/3 first replies; requested detail 505 words, pass 1/1.                         |
| Candidate 5 untouched Workshop         | 109              | Pass 1/1 exchange; requested detail 282 words.                                        |

All assigned explicit-detail continuations passed completeness and navigation checks. The final runs passed source fidelity, uncertainty and unchanged action-state checks under the frozen CR rubric. Word counts include acknowledgements and all visible assistant text in the submitted turn, excluding Markdown link destinations; brevity alone is not a pass.

Independent offline audits reconstructed installed Pi/OpenAI Responses conversion from synthetic sessions. They verified exact style instructions in provider-bound developer content, no extension replacement, and the native low-verbosity parameter without a token cutoff. These are serialization checks, not captured HTTP requests.

### Evaluator correction

The original nonhealth key required positive desktop-trial evidence in the first answer. Candidate 5 omitted that supporting rationale while correctly preserving the recorded decision, scope, timing, blockers, approval uncertainty, next action and contingency; its requested detailed answer included the evidence. Independent AI review and the original source/key author concluded that the key rejected a valid concise summary. Requiring that background solely to satisfy the key would conflict with the user's request for selective first replies.

CR-NONHEALTH.v2 keeps the original source, user prompts, runtime and CR1–CR7 checks. It requires trial rationale when the user asks why, the assistant proposes changing the recorded decision, or omission would materially distort readiness. The original v1 key and red score remain unchanged. The new key and written reason were frozen before a fresh exchange, which passed before the conditional health repetitions ran. No earlier result was retroactively green.

### Validation and limits

| Candidate 5 validation     | Result                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run check`            | Pass: TypeScript, architecture boundaries and formatting.                                              |
| `npm run build`            | Pass; existing large-chunk warning retained.                                                           |
| `npm run test:integration` | Pass on Node 26.7.0: 505 passed, 0 failed, 6 skipped across 511 tests and 19 suites; 71.8 seconds.     |
| Acceptance cleanup         | All 17 harnesses stopped; their 34 containers and 34 schemas absent; no acceptance listeners remained. |

Integration ran after acceptance cleanup. The six skips were five optional native-browser cases and one Linux-only process-group case on macOS; no database exhaustion or other environment failure occurred. Runtime and harness hashes matched the frozen candidate throughout that run.

The final health reviews retain a source-provenance limitation: conditional symptom advice in two first replies had no dedicated opened or cited symptom source; the other first reply opened one but did not link that line separately. The narrower CR checks passed, but this does not establish the earlier health evaluation's stricter B6 provenance coverage or urgent-case handling. No human or clinician validated these results.

This concision pass does not demonstrate live personal-account behavior, new email delivery, calendar writes, autonomous follow-up, schedule dispatch or background-event handling. Existing synthetic appointments and reminders were read and left unchanged. Portal access, incomplete reports, changed bookings and real retest follow-up remain outside this scope.

Private evidence is under ignored `.local/evidence/lab-391/concise-replies-v1/`: `final-acceptance.json`, `observations-summary.json`, each run's independent `review.json`, frozen manifests and receiving/state traces. Final command logs are `validation/candidate5-{check,build}.log` and `final-validation/integration-candidate5-20261002T182949Z.{log,json}`. All baseline failures, earlier candidate failures and the original Atlas v1 evaluator miss remain intact.
