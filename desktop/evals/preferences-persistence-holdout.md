# Independent preference persistence holdout

Frozen at 2026-10-02 00:13:18 UTC by the independent desktop reviewer, after reading only the shared harness contract and before running the held-out case. The fixing agent did not receive the inputs or answer key during that original run. This completed synthetic case was subsequently committed as a regression and retired as an independent holdout. Future independent evaluations must choose new unseen inputs; rerunning this file now proves regression behavior only.

Case: `PERSIST-HOLDOUT-01.v1`

Inputs, in order:

```json
[
  ["preference-quiet-hours", false],
  ["preference-time-zone", "Asia/Tokyo"]
]
```

Expected changed fields:

```json
{
  "quietHoursEnabled": false,
  "timeZone": "Asia/Tokyo"
}
```

The first online GET is held. Both changes must enter the main-process store before closing the renderer, and an independent offline store must read both changes after reopening the durable file. The original primary case edits region and clock format; this case uses a checkbox and time-zone selection. Run three repetitions, each bounded to ten seconds.

Evaluation uses disposable disk state and synthetic responses only. No live model, account, or installed profile is accessed.

## Result

PASS: all three repetitions passed. The main queue and independently reopened durable state each matched the frozen answer key. No source change or answer-key adjustment followed the run.

The log creation and final write timestamps bound the test invocation; Node reported a 566.845709 ms run. Repetition durations were 477.692042 ms, 21.146625 ms, and 22.679875 ms.

```json
{
  "result": "PASS",
  "repetitions": "3/3",
  "logCreatedAt": "2026-10-02T00:13:46.229Z",
  "logCompletedAt": "2026-10-02T00:13:46.822Z",
  "inputSha256": "b5dd1e1c5a0f7c909f102be4671e72a0c8669db2f728e7806a1351b5ddec0962",
  "heldOutBlockSha256": "3ae872c902443a4b3972c4549d25ce587719fb5e083e6cfdf9e97c923aa99afe",
  "testFileSha256": "1ce52614b463f5f843c77fc12624c6e941488668ed5bcead5b05351a78e21248",
  "logSha256": "b76fd4c03bd145454b6d3cb43a8b693224b4029168a1b27c8c6ba55ca9bf86d7",
  "rendererSha256": "b1cb0880106bf35a989a30ad5ff98dfb908fa98d3b4d61443eadaf1adfca8ea6"
}
```

Log: `/tmp/otto-preferences-persistence-holdout-20261002.log`. The input hash covers compact JSON with `edits` then `expected`; the held-out block hash covers its exact formatted source from the test declaration through the end of `settings.test.mjs`.

This establishes the delayed-response renderer-to-main persistence contract. It does not substitute for installed native UI persistence or live assistant acceptance. Root and the runtime packager were notified of the green gate after this check completed.
