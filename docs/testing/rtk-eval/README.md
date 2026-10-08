# RTK acceptance and measured output savings

The native RTK 0.51.0 workspace passes all **30 case runs** on implementation commit `289acf51839ca2658356a00c6477e47e1be734b5`: ten frozen cases, three repetitions each. Four ordinary Git commands produced **2,706 → 1,078 characters (60.2% less)** while preserving the checked filenames, status classes, changed values and commit subjects. Exact CSV exports, machine-readable status, patch files and ordinary directory listings remain unchanged.

![Measured RTK command output savings](savings.png)

These are controlled executions of the actual Pi `bash` tool through `createSandbox` and `createDockerWorkspace`, using synthetic repositories and disposable Linux containers with networking disabled. No model, connected account, UI or live user workload ran. The chart is generated from recorded outputs; it is not a product screenshot. The evaluation follows the requested agent-eval-loop method for frozen cases, independent checks, retained red results and repeated retesting. It does not establish end-to-end language-model task quality.

## Evidence

| Record                                                                                             | Scope                                                                                        |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Frozen cases](baseline/cases.json)                                                                | Matrix v3: prompts, applicability, pass conditions, timeout and repetitions                  |
| [Red baseline](baseline/report.json)                                                               | Source `437687bb17a3944ce9aa01ac37239e5163515365`, original workspace without RTK            |
| [Final candidate](candidate/report.json)                                                           | Committed implementation and the complete native `Dockerfile.workspace` build                |
| [Controlled overlay](candidate-controlled-overlay/report.json)                                     | Same original workspace as baseline, with only the final native RTK binary added; also 30/30 |
| [Computed summary](summary.json)                                                                   | Measured characters, token estimates and illustrative usage costs                            |
| [Original baseline v1](baseline-v1/report.json), [baseline v2](baseline-v2/report.json)            | Preserved earlier case versions                                                              |
| [Candidate red v1](candidate-red-v1/report.json), [candidate red v2](candidate-red-v2/report.json) | Preserved real-binary failures before the safe command grammar                               |

Every attempt retains full raw and Pi-visible output, SHA-256 hashes, exit checks, timestamps and artifact hashes. Reports identify the exact runtime source hash, commit and image. The early red candidates used an uncommitted source snapshot on top of the baseline commit; their adjacent `sandbox.patch` files reconstruct it. They ran the official checksum-verified amd64 musl binary under emulation. The final candidate and controlled overlay use the native arm64 source build from the shipped installer.

## Case matrix

| Case  | Required observable outcome                                                              | Baseline failure           | Final    |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------- | -------- |
| B1.v2 | Invoice status retains all six paths and staged, unstaged, deleted and untracked classes | RTK missing; no compaction | 3/3 pass |
| B2.v1 | Diff retains old/new invoice rate and batch size                                         | RTK missing; no compaction | 3/3 pass |
| H1.v1 | Shipment history retains all five commit subjects                                        | RTK missing; no compaction | 3/3 pass |
| H2.v2 | Shipment status retains all paths and status classes                                     | RTK missing; no compaction | 3/3 pass |
| R1.v1 | CSV redirection preserves all 120 rows byte-for-byte                                     | RTK missing only           | 3/3 pass |
| R2.v1 | `git status --porcelain` remains byte-for-byte identical                                 | RTK missing only           | 3/3 pass |
| R3.v1 | Redirected patch remains byte-for-byte identical                                         | RTK missing only           | 3/3 pass |
| R4.v1 | Exit 23 and its failure text remain visible                                              | RTK missing only           | 3/3 pass |
| R5.v1 | `git diff --output=changes.patch` preserves the complete patch                           | RTK missing only           | 3/3 pass |
| R6.v1 | Ordinary `ls` output remains byte-for-byte identical                                     | RTK missing only           | 3/3 pass |

The original behavior passed the semantic, exit and data-integrity checks. Its case gates failed because bundled availability and automatic compaction were required. In the final candidate, 10/10 cases pass at least once and 10/10 pass every repetition. Eligible output counts are identical across repetitions. These deterministic repetitions verify the tool integration, not model reliability.

## Red and green loop

1. **Missing bundled capability.** The preserved baseline source ran ordinary commands directly; the original image returned exit 127 for `rtk --version`. The hypothesis was that installing the real pinned binary and routing supported ordinary commands through its rewrite interface would reduce output without changing useful results. Every eligible baseline output matched raw output exactly.
2. **Unrestricted rewriting damaged machine output.** Candidate v1 compacted the four Git outputs but failed R2 in all three runs: porcelain status lost its final newline, shrinking from 91 to 90 characters. Matrix v2 added R5 without relaxing R2; R5 also failed all three runs because RTK overwrote the command's patch output with summary data. The hypothesis was that treating machine/file output like display output caused both losses. The fix restricts automatic rewriting to a small explicit grammar of human-readable Git status, diff and log commands. Other forms run unchanged; explicit RTK remains available.
3. **Broadened correctness checks.** Matrix v3 versions both status cases to require correct status classes, and adds raw `ls` preservation. Bare `ls` was left outside automatic rewriting because RTK can add information and increase an already short listing. The final source passes the original failures, the strengthened cases and the holdouts in all three repetitions.

Each matrix version and its red attempts remains in this directory. v2 adds a new regression; v3 strengthens status checks and adds directory-listing preservation. No original check was weakened to obtain a passing result.

## Savings and usage assumptions

| Command                 | Before characters | RTK characters | Reduction |
| ----------------------- | ----------------: | -------------: | --------: |
| `git status` — base     |               483 |             98 |     79.7% |
| `git diff`              |               891 |            547 |     38.6% |
| `git log -5` — holdout  |               849 |            335 |     60.5% |
| `git status` — holdout  |               483 |             98 |     79.7% |
| **Four-command sample** |         **2,706** |      **1,078** | **60.2%** |

Token counts are **estimates**, using `ceil(characters / 4)` per output: **678 → 271**, or about **407 input tokens avoided per four-command sample**. No tokenizer or provider usage meter ran.

| Comparable command calls | Estimated input tokens avoided | At €1/M | At €3/M | At €10/M |
| ------------------------ | -----------------------------: | ------: | ------: | -------: |
| 1,000                    |                        101,750 |   €0.10 |   €0.31 |    €1.02 |
| 10,000                   |                      1,017,500 |   €1.02 |   €3.05 |   €10.18 |
| 100,000                  |                     10,175,000 |  €10.18 |  €30.53 |  €101.75 |

The rates are illustrative assumptions, not current provider prices. Usage assumes this same mix (50% status, 25% diff, 25% log) and each result being ingested once as uncached model input. This estimates only the affected tool-output component. Unchanged instructions, other tools, model output, caching and repeated history ingestion are excluded. Added bash-tool description tokens, rewrite latency, runtime cost and image-build cost are also excluded, so this is not a net-bill measurement. Total agent-bill savings depend on the actual workload and can be much lower as a percentage of the bill. Large diffs and other commands may also have different information-retention tradeoffs.

## Reproduce

Build the complete current workspace and run the frozen candidate:

```sh
docker build -f Dockerfile.workspace -t otto-rtk-candidate .
npx tsx scripts/eval-rtk.ts --image otto-rtk-candidate --output /tmp/rtk-candidate
```

For CI, `--smoke` runs all ten cases once against the specified image. It needs no old Git revision and fails if the binary, semantic checks, output savings or exact-data checks fail. The runner uses temporary synthetic bind mounts, an exact fixture-only Git safe-directory setting, and cleans up files across host/container UID differences. It overrides the image entrypoint so the same command can exercise the Cloudflare image.

The baseline runner accepts `--phase baseline --baseline 437687bb17a3944ce9aa01ac37239e5163515365 --image <image-without-rtk>`. Earlier matrices remain reproducible with `--case-version 1` or `--case-version 2`. Generate the summary and chart from matching `baseline/` and `candidate/` records with:

```sh
node scripts/eval-rtk-report.mjs docs/testing/rtk-eval
```

The renderer refuses mismatched case manifests, fixture hashes, raw outputs or a candidate with failing gates. A final evidence-only commit may differ from the implementation commit recorded in the report; the recorded runtime source hash establishes the exact implementation that ran.
