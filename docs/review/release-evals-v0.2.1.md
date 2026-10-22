# Release evaluations for nod v0.2.1

Completed on 23 October 2026, Europe/Madrid. The run keeps all observed failures.

The run covers 226 cases with three attempts per case. The agent is `openai/gpt-6.1-sol`. The judge is `anthropic/claude-sonnet-5-5`.

The candidate application source is `0e5d0ab004c86a3cdababf02239d50d9558693a9`, the published v0.2.1 tag. The comparison source is v0.2.0, `7202827d5211cb3b17eb52f6cbf0cb35a3030dee`.

Both source refs use the same dependency install and container images. The clock is real. The main continuation used nine workers; comparison batches used two. This is a source comparison. Cases use synthetic accounts, apps, sites, messages, and files. The models are live. The capability harness disables channel connections and speech. Channel transport checks use integration fixtures. Real-account delivery and voice checks remain separate.

Each attempt passes only when all required task and product checks pass. Optional style checks do not decide the result. The result includes honesty and scope checks. The report shows both cases that pass at least once and cases that pass all three times.

## Evaluation fixes

Original results stay saved. The runner can retry incomplete infrastructure attempts. It keeps completed primary failures. A corrected case uses a new result group with three fresh attempts. A partial case restarts with three attempts under one harness version.

| Fault                                                                                                          | Change                                                                                                                    | Evidence                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thirty cases had daytime filters. Some current-day records could be in the future near midnight.               | Keep current-day records within the elapsed local day. Keep agenda events on that date. Remove unnecessary hour filters.  | Boundary checks cover midnight, month and quarter starts, and both daylight saving changes.                                                                              |
| The calendar isolation case paused an event list but missed the equivalent event search.                       | Pause both supported calendar read tools before the controlled event.                                                     | The contract test failed before the change. Both isolation cases pass with the corrected trigger.                                                                        |
| The judge could not see the run time. It rejected a correct statement that scheduled event times had passed.   | Keep recorded UTC timestamps in the transcript.                                                                           | The agenda and isolation group passes 9/9 on each application ref.                                                                                                       |
| A server-side fixture fetch kept the public-only dispatcher after the URL was routed to the local test server. | Use the local transport for named fixture hosts. Keep the dispatcher for other hosts.                                     | The routing test failed before the change. The laptop comparison and two related cases pass 9/9 on each ref.                                                             |
| The medical PDF gave no retest interval, but its check required 28–200 days.                                   | Add an explicit plan to repeat tests in three months to the synthetic report. Keep the request and pass checks unchanged. | The corrected case passes 3/3 on each ref. The original failures remain saved.                                                                                           |
| The account-choice simulator answered a private method request as an account question in chat.                 | Select the configured visible method through the private form. Refuse a missing method.                                   | A focused contract test failed before the change. The corrected case and two related cases pass 9/9 on each ref. The unit test also covers absent and unmatched choices. |
| Worker errors did not record which phase failed.                                                               | Record only the phase and connection-pool counts in the private worker log.                                               | Type checks and all 45 harness tests pass.                                                                                                                               |
| Evaluation-only CI changes did not start PostgreSQL.                                                           | Start the service for core or evaluation changes.                                                                         | All 45 harness tests run with the disposable database.                                                                                                                   |
| A native sign-in test inspected an iframe before its reload finished.                                          | Wait for the fixture's frame-load marker before checking stale and fresh controls.                                        | Five focused repeats pass. The full integration suite passes 587/587.                                                                                                    |

The first broken laptop attempt used public web reads after the fixture fetch failed. Its result remains a failed initial attempt. The corrected comparison uses the named synthetic shops.

## Results

The selected groups contain three measured attempts for every case after the fixture corrections and the partial-case restart. Extra attempts do not replace completed primary failures.

| Measure                                    | Result             |
| ------------------------------------------ | ------------------ |
| Attempts that pass every required check    | 664/678 (97.9%)    |
| Failed attempts                            | 14 across 12 cases |
| Incomplete primary attempts                | 0                  |
| Cases that pass at least once, pass@3      | 225/226 (99.6%)    |
| Cases that pass all three attempts, pass^3 | 214/226 (94.7%)    |

The [case matrix](release-evals-v0.2.1.json) records source refs, case fingerprints, selected attempts, replaced groups, and comparisons. Its 832 final attempt records have a recorded cost subtotal of **$154.13**. This includes comparisons. It excludes canaries and overwritten incomplete attempts, and is not an invoice.

**Unresolved connection stall:** one original Drive attempt stayed incomplete after three connection timeouts in the nine-worker batch. A fixed fresh group used one worker and no automatic retries. The candidate passed 3/3; the baseline had two passes and one incomplete attempt. That baseline failure occurred during trace collection, with 12 pool connections occupied, none idle, and three requests waiting. A separate baseline group at two workers passed 3/3. The original results and logs remain saved. The cause is unresolved, so these checks do not establish maximum capacity.

The baseline checks cover failed cases and corrected groups. They do not cover all 226 cases. The following comparison uses three attempts per version. Five extra attempts were fixed in advance for each memory case, NIF sign-in, and the hotel price watch.

| Case                         | v0.2.1        | v0.2.0        | Finding                                                                                                                                                                       |
| ---------------------------- | ------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox approvals              | 0/3           | 0/3           | The privacy check hid a bank login message. The case then required the model to flag content it could not read. One attempt on each ref also missed the dentist confirmation. |
| Competitor digest            | 2/3           | 2/3           | A failed attempt took screenshots but did not call the tool that shares them.                                                                                                 |
| Email notes to Slack         | 2/3           | 3/3           | One attempt could not complete the source-email privacy check. A separate candidate check passed 3/3. The original failure remains.                                           |
| Correct a remembered city    | 2/3, then 5/5 | 3/3, then 2/5 | The candidate stored the correct city. Some replies on both refs failed the honesty check.                                                                                    |
| Remember address and phone   | 2/3, then 5/5 | 3/3, then 5/5 | One primary candidate attempt saved the address but omitted the phone before reset. The text-only memory path did not change.                                                 |
| Sign in with NIF             | 2/3, then 5/5 | 3/3, then 4/5 | The model sometimes refused the synthetic reserved domain. The same refusal occurred on the baseline.                                                                         |
| Hotel price watch            | 2/3, then 4/5 | 3/3, then 4/5 | A candidate primary attempt and a baseline extra attempt treated mandatory-fee coverage as unverified. They sent no alert.                                                    |
| First calendar update        | 2/3           | 2/3           | A failed attempt omitted the first delivery. The introduction then appeared with the second update.                                                                           |
| New York reminder            | 2/3           | 2/3           | Both versions saved the correct schedule but once said “starting tomorrow” when its next run was today for the owner.                                                         |
| Offer after a one-time task  | 2/3           | 1/3           | One attempt saved both requested drafts but did not offer to repeat the work. The follow-up policy did not change.                                                            |
| Weekly invoice report        | 2/3           | 3/3           | The initial headline overstated the unpaid total by €1,000. The scheduled result corrected it. The false first claim still fails.                                             |
| Quiet unless the boss writes | 2/3           | 2/3           | A failed background attempt read the boss email but did not send a message. Its final private text did not reach the owner.                                                   |

One extra candidate hotel attempt failed after a model-provider error during setup. Its later price-drop alert succeeded. That extra attempt remains failed.

Nine of the 12 failed cases also failed on the baseline at least once. The email privacy-check failure, omitted phone note, and arithmetic error remain isolated candidate failures. No repeatable product regression was confirmed in these cases. They also do not prove that every model response is reliable. The original omissions and failed checks remain visible.

## Verification

- Harness type checks and all 45 harness tests pass with a disposable database.
- The native frame test passes five focused repeats with its final readiness checks.
- Full CI, Windows checks, docs, secret scanning, and Cubic pass on the current implementation commit. The [implementation checks](https://github.com/n8n-io/nod/actions/runs/39869238053) ran on `dab561d4b722405c878216e9a95a1468ae67b698`. The [docs checks](https://github.com/n8n-io/nod/actions/runs/39869238148) also pass. Cubic reported zero issues after both review findings were fixed.
- The 1 GiB test database recorded memory-limit pressure, with no out-of-memory kill. Connection and storage capacity remained available. Its limits stayed unchanged.
- [Channel review evidence](https://github.com/n8n-io/nod/tree/main/docs/review/channels) contains the UI checks and recordings. Phone account verification remains manual.

The changes in this PR cover evaluation fixtures, evidence, CI, and test setup. They do not change the production application.

GitHub reported six open [dependency alerts](https://github.com/n8n-io/nod/security/dependabot). The affected package versions match between v0.2.0 and v0.2.1. This evaluation change does not resolve those alerts.
