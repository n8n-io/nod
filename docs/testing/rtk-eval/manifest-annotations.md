# Frozen manifest wording clarification

The historical `C5-exact` wording “exported CSV/patch bytes match independent inputs” overstates the independence of the patch reference. Its checks actually establish:

> Machine status is byte-identical to raw output, exported CSV bytes match the independent input, and patch bytes match raw Git output.

The CSV reference is the independently generated fixture input. Patch equality compares the Pi-created artifact with the output of the same raw Git command in the synthetic repository; it is not an independently authored complete patch oracle. C5 also compares ordinary listing output in v3–v5 and complete merge history in v5–v6 with their raw commands.

Starting in v4, `C7-patch-content` separately checks independent expected facts from the fixture: the staged export file addition, old and new values in unstaged tracked files, and deleted content. Earlier v1–v3 records do not have this check and gain no additional evidence from this clarification.

This annotation applies to the frozen manifests in `baseline-v1` through `baseline-v5`, `baseline-v6-initial`, `baseline-v6-before-c5`, `candidate-red-v1`, `candidate-red-v2`, `candidate-red-v5`, `candidate-controlled-overlay`, `candidate-v3` through `candidate-v5`, `candidate-v6-initial`, `candidate-v6-before-pretty`, and `cloudflare-smoke-v6-before-pretty`. Their manifest bytes, recorded hashes, scores and observed outputs remain unchanged.

New runs in `baseline`, `candidate` and `cloudflare-smoke` emit the corrected C5 wording and explicitly describe C7's independent semantic expectations. The scoring logic, case inputs, applicability and pass conditions are unchanged, so these are matrix v6 reruns rather than a new case version. Their new manifest and harness hashes record the wording correction.
