# Chat and feedback acceptance

Frozen on 2026-10-07 using the supplied `agent-eval-loop` skill. These cases cover the remaining user requests after the annotation editor review. They do not turn fixture results into connected-account or installed-release evidence.

## Cases

| ID      | User task                                                                        | Setup and outcome                                                                                       | Required checks                                | Holdout                                                            | Run rule                                                                                         |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| FE01.v1 | Keep what I added to the image editable after saving.                            | Synthetic screenshot in the real feedback UI; save, reopen, edit and delete earlier marks.              | EDIT, ORIGINAL, EXPORT, HISTORY                | Portrait image with a resized comment and cover                    | One base and one holdout, 10 minutes each; browser, no model                                     |
| FE02.v1 | Keep my unfinished feedback if I reload or restart.                              | Isolated owners and synthetic text/files; reload and restore the draft.                                 | DRAFT, OWNER, STORAGE, CLEAR, PAYLOAD          | Different category, report opt-out, document and edited screenshot | One base and one holdout, 10 minutes each; browser, no model                                     |
| FE03.v1 | Do not lose my image edits when I close the editor accidentally.                 | Unsaved mark or comment draft; exercise Escape, close and cancel.                                       | CLOSE, KEEP, DISCARD                           | A reopened image with an existing saved annotation                 | One base and one holdout, 10 minutes each; browser, no model                                     |
| FE04.v1 | Let me paste an image and include a screenshot in feedback from the desktop app. | Disposable native Electron profile, production renderer/preload/capture logic, synthetic content.       | NATIVE, CLIPBOARD, PRIVATE                     | Text paste and capture from a protected route                      | One base and one holdout, 15 minutes each; native UI; no model                                   |
| FE05.v1 | Send my idea with the image, file and diagnostic context included.               | Isolated real feedback service and UI; explicitly authorized live n8n intake and Linear receiving view. | DELIVERY, RECEIVING, HASHES, CATEGORY, PAYLOAD | Other category with a different supported document                 | One base and one holdout, 10 minutes each; live delivery with synthetic content                  |
| FE06.v1 | Answer my request once while background work is running.                         | Real Otto harness/model with disposable schemas and fake external apps; LAB-529.                        | TASK, TRIGGER, ONCE, SCOPE                     | Different request and trigger ordering                             | Freeze model/setup in the scenario record before running; three attempts per base and holdout    |
| FE07.v1 | Use the feedback controls and chat changes we reviewed.                          | Real renderer and synthetic API; original LAB-482/478/528/479 and approved LAB-472 scope.               | CHAT, INTRO, ATTACHMENTS, TOOLS, DIAGNOSTICS   | Narrow viewport and another attachment aspect ratio                | One regression pass, 15 minutes; browser, no model                                               |
| FE08.v1 | Ship the reviewed changes.                                                       | Reviewed pull request; exact revision CI; compatible intake before app rollout.                         | CI, MERGE, RELEASE                             | Not applicable                                                     | Observe actual workflow completion and released revision; do not substitute local build evidence |

## Checks

All checks are required when named by their case. A case passes only when all applicable checks pass in one attempt. Missing prerequisites block a run; measurement failures are errors, not passes. Base and holdout must both pass. UI cases use fixed synthetic inputs; LAB-529 holds its answer key outside agent context.

| Check       | Applies when                                    | Observable pass condition                                                               | Evidence and method                                        |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| EDIT        | A saved image contains annotations              | Earlier marks remain selectable and editable after reopening                            | Browser state and raster output; human/code                |
| ORIGINAL    | Every mark has been removed                     | Saving restores the original image bytes                                                | File hash; code                                            |
| EXPORT      | An image is saved while zoomed                  | Export contains the whole image at its original dimensions                              | Image dimensions and pixels; code/human                    |
| HISTORY     | An annotation changes                           | Undo and Redo restore the previous and next states exactly                              | Raster and mark state; code/human                          |
| DRAFT       | Feedback has text or attachments                | Reload restores text, category, report choice, files and editable marks                 | Browser state and file hashes; human/code                  |
| OWNER       | A draft exists for another owner                | The other owner cannot restore or overwrite it                                          | Storage/owner regression and browser; code/human           |
| STORAGE     | Persistence fails                               | In-memory work remains and the UI gives a truthful recovery warning                     | Isolated failure harness; code/human                       |
| CLEAR       | Feedback is accepted or deliberately discarded  | Reload does not resurrect the cleared draft                                             | Browser and storage; human/code                            |
| PAYLOAD     | An annotated file is sent                       | Only the rendered attachment is sent, without the original image or local editing state | Outbound envelope; code                                    |
| CLOSE       | The image editor has unsaved work               | Closing requires an explicit discard decision                                           | Browser; human                                             |
| KEEP        | Discard is declined                             | The editor and unsaved edits remain                                                     | Browser; human                                             |
| DISCARD     | Discard is confirmed                            | Only unsaved editor changes are discarded                                               | Browser and raster; human/code                             |
| NATIVE      | Native capture is available                     | A real Electron capture appears as an attachment                                        | Native UI and capture trace; human/code                    |
| CLIPBOARD   | The OS clipboard contains an image              | Native paste adds the matching image once                                               | Native UI and dimensions/hash; human/code                  |
| PRIVATE     | A protected route or private input is visible   | Automatic capture returns no attachment                                                 | Native capture contract and UI; code/human                 |
| DELIVERY    | A live feedback submission occurs               | The app obtains a submitted receipt for that submission                                 | App UI and real receipt; human/code                        |
| RECEIVING   | Delivery reports success                        | Linear displays the matching issue and every requested attachment                       | Authenticated receiving view; human                        |
| HASHES      | Received files can be downloaded                | Received bytes match submitted SHA-256 hashes                                           | Authenticated download and hash; code                      |
| CATEGORY    | Idea or Other includes diagnostics              | The diagnostic is attached to the matching issue                                        | Receiving view; human                                      |
| TASK        | A foreground request was triggered              | The requested action finishes with the independently expected result                    | Real harness state/trace; code/human                       |
| TRIGGER     | Background work overlaps the request            | The real dispatcher starts the background turn                                          | Turn/dispatcher trace; code                                |
| ONCE        | Foreground and background turns finish          | The request produces one action and one non-conflicting completion                      | Action state and delivered messages; code/human            |
| SCOPE       | Background work runs                            | It acts only on its own trigger                                                         | Trace, external fake state and final output; code/human    |
| CHAT        | A paste or assistant response is shown          | Newlines are preserved; removed labels and pulsing cursor stay absent                   | Browser and existing integration regressions; human/code   |
| INTRO       | Feedback onboarding is due                      | The subtle anchored introduction identifies the actual button                           | Browser; human                                             |
| ATTACHMENTS | Multiple attachments exist                      | Tiles have consistent dimensions and preserve image fit                                 | Browser; human                                             |
| TOOLS       | An image is annotated                           | Pen, highlight, comment, cover, color, move, resize, delete and zoom operate correctly  | Browser and raster harness; human/code                     |
| DIAGNOSTICS | A feedback category is selected                 | Diagnostics default on for all categories and preserve explicit opt-out                 | Browser and delivery contract; human/code                  |
| CI          | A candidate revision exists                     | Required checks pass for that exact revision                                            | GitHub checks; code                                        |
| MERGE       | The reviewed candidate is approved for delivery | The pull request is merged and the resulting SHA is recorded                            | GitHub pull request; code                                  |
| RELEASE     | The candidate is merged                         | Compatible intake and app release are published and verified                            | Published workflow/release metadata and checks; code/human |

## Evidence rules

Record each attempt's commit, working-tree fingerprint when dirty, input hashes, timestamps, environment, trace location, check results and cost (or unavailable). Synthetic artifacts and red hypotheses live under `.local`; no private content or secrets belong in Git. Preserve failed attempts before making fixes. Version any materially changed check with its reason. Native development-shell evidence is distinct from installed signed-release evidence.

## Results

The implementation addresses [LAB-482](https://linear.app/n8n/issue/LAB-482), [LAB-478](https://linear.app/n8n/issue/LAB-478), [LAB-528](https://linear.app/n8n/issue/LAB-528), [LAB-479](https://linear.app/n8n/issue/LAB-479), [LAB-529](https://linear.app/n8n/issue/LAB-529), and [LAB-472](https://linear.app/n8n/issue/LAB-472). Original issue descriptions, screenshots and diagnostic reports informed the fixes.

### Controlled checks

- FE01 and FE03 passed mounted component and raster checks, including a portrait holdout, original-byte restoration, original-resolution export, saved-mark editing, Undo/Redo, dirty close, comment keyboard submission and unload protection. The holdout exposed Escape during drawing; the gesture now cancels consistently. An asynchronous focus assertion required a harness timing repair, retained separately from production fixes.
- FE02 passed owner isolation, hydration race, reload, storage failure, accepted-clear failure, explicit discard, immutable retry and rendered-only payload checks. Storage failures preserve the in-memory work. Failure to clear an accepted draft offers a local retry without resending the feedback.
- FE07 passed the retained 37-case paste regression and UI review of the approved controls. Tiles are fixed at 148 × 104 pixels and show the entire image. Dictation remains excluded.
- Before review fixes, root integration: 635/635 on `9275c4393d6f0aa4a1037d6803809d34c5ec4971`; Cloudflare: 424/424; desktop: 118 passed, one skipped; n8n workflow: 13/13. TypeScript, architecture and image checks passed. Final formatting/build and delivery CI are recorded with the pull request.

### Native development-shell acceptance

FE04 passed on macOS using an isolated Electron 44.5 profile, the production preload, and the exact production capture function. A real macOS clipboard copy from Preview added one 360 × 900 image. Enter submitted an image comment. A native reload restored text, category, files, diagnostics choice and editable marks. Saved-mark selection, keyboard deletion, Undo, Redo and discard protection worked. Opening feedback from Vault produced no screenshot. Plain-text paste preserved its newline. A later app restart confirmed the accepted draft did not return.

This is development-shell evidence, not installation or signing acceptance of a released binary. All account data in the shell was synthetic, and non-feedback writes were disabled.

### Live receiving verification

FE05 base and holdout passed through the real feedback service, published n8n workflow and authenticated Linear receiving view:

| Case  | Received issue                                  | Verified files                                                               |
| ----- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Idea  | [LAB-545](https://linear.app/n8n/issue/LAB-545) | Native screenshot, annotated clipboard image, log file and diagnostic report |
| Other | [LAB-546](https://linear.app/n8n/issue/LAB-546) | Native screenshot, CSV file and diagnostic report                            |

All seven received files were downloaded from Linear and matched the submitted SHA-256 hashes. Linear rendered the annotated image at its original 360 × 900 dimensions. Outgoing files contained only the rendered bytes, name, MIME type and digest; originals and editing marks stayed local.

The active [Otto Feedback workflow](https://internal.users.n8n.cloud/workflow/8DyrtVGHFLptHwTr) was updated and published as version `390bf2c0-1f6e-4c22-a86d-4c7049b0cec5` before these submissions. Only the intake validator changed; other nodes, connections and settings were preserved. The old validator rejected documents and diagnostics for Idea/Other; the published validator accepted the same synthetic inputs.

### Remaining delivery gates

FE06 is recorded in [the LAB-529 evaluation](../../evals/lab529.md). FE08 requires the exact pull-request revision's CI, merge record and published app release; these are not inferred from local tests or the already-published intake.

### Auditable run index

[The sanitized evidence index](chat-feedback-evidence.json) records case versions, timestamps, exact source fingerprints, input hashes, environment, result manifests and file digests. Each result applies to its recorded source; later review fixes require their own checks. Raw traces stay in the named `.local` paths in the evaluation checkout and are intentionally excluded from Git. Their hashes allow the retained records to be matched without publishing diagnostics or profiles.

| Acceptance        | Result manifest in the evaluation checkout                                                             | Revision or source identity                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| FE01 / FE03       | `.local/debug/annotation-eval/green-mounted.json`, `holdout-pr-review.json`, `unload-green.json`       | Per-run component SHA-256 in the index; the unload run predates review fixes                                    |
| FE02              | `.local/debug/draft-eval/green-form.json`                                                              | Dirty implementation on `ed66ff0`, with four exact file hashes                                                  |
| FE04              | `.local/feedback-eval-2026-10-07/native-manual-acceptance.json`                                        | Native shell source and synthetic input hashes in the index                                                     |
| FE05              | `.local/feedback-eval-2026-10-07/linear-LAB-545-verification.json`, `linear-LAB-546-verification.json` | Submission IDs, receiving timestamps and all seven SHA-256 comparisons                                          |
| FE06              | `.local/capability-evals/lab529-merged-9275c43-acceptance-v2.json`                                     | `9275c4393d6f0aa4a1037d6803809d34c5ec4971`; v2 base and holdout, three attempts each, 54 required checks passed |
| Review privacy    | `.local/debug/capture-privacy-eval/green.json`                                                         | Parent `9275c43` plus four changed-file hashes; red logs and hypothesis retained alongside it                   |
| Review annotation | `.local/debug/annotation-review/green.json`                                                            | Five changed-file hashes; frozen cases, red results and hypotheses retained alongside it                        |

The reviewed parent revision passed [CI, integration and E2B acceptance](https://github.com/n8n-io/otto/actions/runs/37667165096) and [desktop update acceptance](https://github.com/n8n-io/otto/actions/runs/37667165268). These links identify historical runs, not the eventual merge candidate. [PR #153](https://github.com/n8n-io/otto/pull/153) carries the final revision's checks and review resolution.

Reproduce the committed contracts with `npm run check`, `npm run test:integration`, `npm run build`, `npm --prefix desktop test`, `node --test deployment/n8n/feedback.test.mjs`, `npm --prefix evals run check` and `npm --prefix evals test`. Run integration and build sequentially because they share build outputs. Use disposable schemas for integration and the [LAB-529 frozen protocol](../../evals/lab529.md) for model evaluations. Manual UI checks and authenticated Linear downloads remain separate from these commands.

The review fixes then passed 636 integration tests, 118 desktop tests (one skipped), 13 workflow contracts, 32 eval-harness tests, root check and build. At 320 × 760, the feedback categories and annotation tools fit without horizontal overflow; the smallest toolbar uses readable 3+2 rows. The onboarding actions are keyboard reachable without taking initial focus. An actual renderer check refused capture with unsent chat text and captured again after it was cleared. Fingerprints and raw-log digests are in the review records of the evidence index. The unchanged six-attempt model rerun and final CI are recorded on the PR before merge.
