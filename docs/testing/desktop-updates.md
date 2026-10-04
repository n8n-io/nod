# Desktop automatic updates

Frozen 2026-10-04 before implementation, source `a40a4e0277f4426ac75644e7d06a4079ab4986be`.

User outcome: Otto discovers the next signed desktop release, prepares its matching computer runtime, and offers a restart that preserves unfinished work. Private release delivery uses n8n; the same selection logic can use public GitHub later.

## Controlled cases

These are deterministic application-boundary regressions using synthetic release records, disposable runtime archives/cache directories, the real preload, and controlled native-updater events. No normal profile, VM, accounts, models, signing keys or published releases are touched. One run per case per implementation; repeat only on a changed implementation or measurement defect. Each case passes only when every listed check passes in that run.

| Case    | Input                                                                                          | Required observable result                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| DU01.v1 | Published version 0.2.0, installed 0.1.0, valid runtime and exact asset IDs                    | Select exact newer release; runtime verification finishes before native staging; downloaded event alone never restarts. |
| DU02.v1 | Equal/older releases, unrelated tags, drafts                                                   | No runtime installation or native staging.                                                                              |
| DU03.v1 | Wrong runtime content ID, altered descriptor claiming installed ID, corrupt archive            | Fail before native staging; existing cache bytes and marker stay unchanged.                                             |
| DU04.v1 | New runtime ID, valid synthetic tar, then repeat same candidate                                | Verify and install into its own cache; reuse verified cache without download; installed runtime stays usable.           |
| DU05.v1 | Draft text, attachment/upload, pending send, missing renderer response or settings window      | Defer restart without drain or native quit; release any temporary interaction lock.                                     |
| DU06.v1 | Clear trusted renderer, active engine work                                                     | No drain or native quit; update remains ready.                                                                          |
| DU07.v1 | Clear trusted renderer, drain fails                                                            | Resume exact transition; release renderer; retain ready update; no lifecycle close or native quit.                      |
| DU08.v1 | Clear trusted renderer, idle engine, successful drain                                          | Close existing lifecycle and flush cursors before native quitAndInstall; no second runtime is started.                  |
| DUH1.v1 | Broker versus direct GitHub records, reordered asset list, wrong archive size or descriptor ID | Same exact release selected; mismatched metadata fails closed.                                                          |
| DUH2.v1 | Untrusted frame, stale restart token, delayed renderer response                                | Cannot authorize restart or retain an interaction lock after cancellation.                                              |

Evidence is the existing desktop settings/runtime test output and explicit call ordering/readback assertions. Input builders and answer keys are committed with those existing tests. Their source SHA-256 is recorded with the final run. Time limit: 120 seconds per focused file; live-model cost: zero. Native two-version signed installation and relaunch remain a separate root-owned acceptance case; these regressions cannot establish Squirrel, code-signature, Gatekeeper or fresh-onboarding acceptance.

## Baseline and hypothesis

Baseline source has no native update discovery, staging or restart action. DU01/DU08 therefore have no executable path. Existing runtime cache validation checks each file but accepts an arbitrary 64-character descriptor ID; the installer can replace that ID's cache. DU03 requires a content-addressed descriptor and an explicit same-current-ID collision fence before remote installation. Existing provider restart already uses status/drain/resume; the update path should reuse that transition contract and the existing lifecycle close.

## Attempts

Final controlled run on `d4c1d31` plus the recorded working-tree hashes: desktop settings 76/76; runtime assets 43 passed, 0 failed, with the existing Linux-only firewall case skipped on macOS; actual Chat component guard 1/1. TypeScript and formatting checks passed. The dedicated privileged Linux CI step must supply the platform firewall evidence; the regular integration command does not execute that desktop case. Logs and file hashes are under ignored `.local/desktop-updates/`.

DU01–DU08 and DUH1–DUH2 pass at the controlled application boundary, including the review refinements below. This does not claim a signed native upgrade, public GitHub delivery, or live n8n access. The broker's saved credential returned 404 for this private repository; its live delivery remains blocked separately.

## Review refinements

The initial controlled settings run passed 72/72. Independent source review identified three additional failure paths before acceptance: an unfinished native download could outlive the client timeout; shutdown rollback could restore a renderer after its engine closed; and an empty hidden Composer could approve restart while another form was open. DU08.v2 and DUH2.v2 extend the original gate to cover those boundaries. Native attempts now remain exclusive until a terminal event, cursor writes happen before irreversible shutdown, and the existing quit retry loop finishes shutdown while interaction remains locked. Chat must be visible, with no active dialog. Navigation invalidates the guard before shutdown, and old acknowledgements cannot approve a later attempt.

PR review added held-out regressions for an unchanged runtime gaining or changing its optional download URL, a send still pending after its chat thread changes, and input committed before passive editor effects run. Each reproduced a failure before its fix. Runtime reuse ignores only the optional URL and still verifies all cached bytes; a separate outstanding-request count survives thread changes; a layout effect and the parent text value keep restart decisions current. The focused rerun passed six Chat/queue cases and eight runtime cases. Red/green receipts are retained under ignored `.local/desktop-updates/pr111-*.log`.

The shared broker contract test also caught a list-query mismatch; broker list requests now have no query and accept its bounded 500 published records. Exact ZIP and runtime asset digests must match their manifest hashes. These changes use the existing protocol and native quit flow.

One existing runtime test changed its synthetic file manifest without updating its content ID; the stronger ID check rejected that fixture. The fixture now recalculates the ID while retaining its same-size corruption and executable-mode checks. A new shutdown test initially used an asynchronous rejection assertion for a synchronous lifecycle exception; the measurement was corrected. Separate red receipts and source hashes are saved under ignored `.local/desktop-updates/`.

## Switching to public GitHub

Make the repository public, then deliver a build with `OTTO_DESKTOP_UPDATE_SOURCE_URL` unset through the existing n8n source. That build uses the fixed public GitHub API. Keep the n8n routes available while earlier clients migrate; remove the workflow after they no longer depend on its baked source URL. The original 0.1.0 alpha has no updater and needs one manual app upgrade.
