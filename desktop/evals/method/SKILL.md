---
name: agent-eval-loop
description: Turn real AI assistant tasks into end-to-end evaluation cases, score observable results, and fix general failures through a red and green loop. Use for task evaluation matrices and agent acceptance work, not routine unit tests.
---

# Agent Eval Loop

Use this method for an assistant task whose real outcome matters. One case is one user task under a fixed setup. The case has one binary end-to-end result. Named checks show why it passed or failed. Use shared checks across cases and add checks for the task's own result. This task-level gate adapts n8n's [shared workflow checks and case expectations](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/instance-ai/evaluations/README.md). Follow the project instructions and the user's action limits.

If the user asks only for a method or a prompt, provide that deliverable. Start runs when the user asks for evaluation work or an existing instruction authorizes it.

## Define the case

1. Start with a real user request. Keep the prompt in the user's voice. Do not put the answer or the expected tool sequence in it.
2. State the outcome that a person must see. Select a controlled setup, input data, an independent answer key, and evidence for the result. For changing public sources, save the source state and date before the run, then check the source again during scoring.
3. Write shared and case checks before the first run. Give each check one observable pass condition, an applicability condition, an evidence source, and a scoring method: code, human review, or model judge. Use code for exact values, files, actions, and timing. A model judge can assess meaning; inspect its evidence for important or disputed results.
4. Define the case gate: the end-to-end result is **pass** only when all required, applicable checks pass in the same run. A failed check makes the case **fail**. Record **not applicable** only when the frozen applicability condition has no subject. Record **error** when measurement fails. Neither is a pass. A missing account, input, or source supply blocks the run before scoring.
5. Freeze the exact prompt, checks, setup, input hashes, answer key, model, environment, time limit, and any repeat count. Record the tested commit for each attempt. Give each case and check a stable ID. A material check change creates a new case version with a written reason; retain the old run.

Use [the case and run templates](references/records.md) when you create a matrix or run log. Create a small set of held-out cases by changing entities, source state, input format, timing, or account state while keeping the same user need. Keep their answer keys out of the agent's context.

## Run and score

1. Check that the test environment works with one small end-to-end task before a batch. An environment failure is not an agent failure.
2. Give the agent only the frozen prompt and stated inputs. Use its normal chat, tools, browser, files, connections, and scheduler. Observe a scheduled result after the normal dispatcher starts it. A saved schedule alone cannot pass a scheduled case.
3. Save the visible result and trace: task ID, model, commit, start and end time, tool actions, source pages, output files and hashes, cost or unavailable cost, and each check's evidence. Keep private content and secrets out of Git and logs. Separate fixture, isolated app, UI, and live account evidence.
4. Check that each required condition actually occurred. A rule such as “no duplicate send” proves little if the agent never reached a send. Verify the trigger, the action, and the outcome. Open cited sources and produced files. Do not treat task completion, a valid link, or a judge's green result as proof by itself.

## Red and green loop

For each red result, write a hypothesis **before** a fix. Name the failing check, likely cause, predicted trace, and evidence that would disprove the hypothesis. Inspect the trace, then classify the red as an agent gap, test setup fault, source change, or evaluator fault.

Fix an agent gap at its general cause in the owning module. Do not add a branch for one prompt, URL, fixture value, or expected answer. Run a focused check, repeat the frozen end-to-end case, run a held-out case, and run related regression cases. If a check rejects a valid way to meet the user's goal, version and correct the check; do not weaken it merely to make a red result green.

When behavior varies, choose a repeat count before the repeat runs. Report both the share that passes at least once and the share that passes every time. A single lucky pass does not establish reliable behavior. Keep the case red until the defined base, holdout, and regression gates pass on the current commit and model.

## Report

Show the matrix with case status, check results, evidence links, hypotheses, fixes, and remaining gaps. State what ran in the real app, what ran with synthetic data, and what has no live check. Continue with other cases when one case is blocked. Stop when the requested cases meet their gates or no useful work can proceed without a missing dependency. Do not turn a fixture pass or an earlier run into a current end-to-end claim.
