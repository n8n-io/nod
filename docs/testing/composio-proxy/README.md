# Managed integrations acceptance

The [original frozen cases](cases.v1.json) and [version-two upgrade cases](cases.v2.json) apply the user-supplied `agent-eval-loop` method. The original no-reconnect requirement remains archived with its results. The user later chose no legacy compatibility and asked to be told when reconnect is necessary; CP02/CP03 version two test that decision. No release is approved until its current required cases pass on the final source.

Each attempt records commit and dirty-source fingerprint, input hashes, start/end time, tool trace, check evidence and result. The app receives normal inputs; evaluator assertions stay outside its context. These cases evaluate app and provider contracts without a live Pi model. Fixture success does not establish real OAuth consent or live connected-account execution.

## Checks

Every named check is required for its case. It applies whenever the frozen setup contains its subject. Missing setup blocks before scoring. An observation failure is an error; a failed check fails the case. One base and one holdout must pass within ten minutes each. Repeating only a lucky variant cannot make a case pass.

| ID        | Observable pass condition                                                                                      | Evidence and method                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| KEYLESS   | An empty profile loads the app catalog and begins consent without a project key                                | Real app route and outbound trace; code/UI                                 |
| OAUTH     | Only the initiating installation and browser can complete consent                                              | Callback trace plus owner-bound account; code/UI; live acceptance separate |
| OWNED     | Every account/session operation uses the authenticated owner; another owner receives no private data           | Authoritative provider fixture, response and upstream trace; code          |
| SECRET    | Project keys, raw provider credentials and private signing keys remain outside renderer, sandbox, logs and Git | Output/configuration scan and boundary inspection; code/human              |
| PRESERVE  | Upgrade retains every existing connection ID, grant, active state and saved settings                           | Before/after disposable database and profile; code                         |
| ROUTE     | An existing connection executes through its original project and owner                                         | Stateful provider fixture action journal; code                             |
| POLL      | Existing inbox polling resumes with the same account and cursor                                                | Dispatcher and provider journal; code                                      |
| NEW       | A new desktop connection selects the hosted provider                                                           | Real composition and outbound trace; code                                  |
| FORGE     | Altered method, target, body or account/session ownership cannot authorize a request                           | Worker response and upstream journal; code                                 |
| REPLAY    | An identical signed request is accepted at most once                                                           | Real workerd replay store and upstream journal; code                       |
| BYTES     | The stored attachment bytes exactly match the workspace source                                                 | Independent SHA-256 comparison after retrieval; code                       |
| FILEOWNER | Another owner cannot fetch, replace or execute with the attachment reference                                   | Two-session provider probe plus broker trace; code                         |
| IMMUTABLE | Later uploads cannot change the bytes behind an issued attachment reference                                    | Same-content and collision variants, before/after hashes; code             |
| ACTION    | The normal app tool path uses the owned attachment with the selected account                                   | Actual SDK and controlled receiving fixture; code; not live delivery       |
| REPLAYUI  | Replay starts the native wizard and complete product onboarding again                                          | Actual native/web route and renderer; UI/code                              |
| DATA      | Replay preserves connections, chats, credentials and preferences                                               | Before/after disposable stores; code                                       |
| DEV       | Development web exposes replay; production web does not                                                        | Real built renderer; code/UI                                               |
| CI        | The final PR revision passes repository checks                                                                 | GitHub run and exact SHA; code                                             |
| DEPLOY    | A successful main-branch workflow deploys the intended Worker revision                                         | GitHub run and Cloudflare deployment; code                                 |
| CATALOG   | The deployed Worker serves the real SDK's signed keyless catalog request                                       | Deployed request/result metadata; code                                     |

## Matrix

| Case                                 | Status                                   | Evidence and remaining gate                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP01 clean install                   | Blocked                                  | Actual local/HTTPS consent remains gated on coordinated project activation and a dedicated synthetic provider account.                                                                                                                      |
| CP02.v2 existing desktop connections | Passed; real consent remains gated       | [74 focused cases](cp02.v2.md) verify one-time replacement, callback admission and cancellation/foreign/stale denial. Final native upgrade uses simulated consent; the exact local entry and data survive, and pairing clears on return.    |
| CP03.v2 server configuration         | Passed                                   | [16 actual composition variants and four database preservation variants](cp03.v2.md), including genuinely old schemas, missing fingerprints and same-project key rotation.                                                                  |
| CP04 isolation                       | Passed on 994fc6d                        | [Frozen base and holdout](cp04.v1.md), actual SDK and real local Durable Object replay passed.                                                                                                                                              |
| CP05 workspace attachment            | Passed on final Worker/server            | [Base and collision holdout](cp05.v1.md), six synthetic receiving drafts, 12 denied attacks, 15 MiB workerd and live temporary storage. No real account delivery claim.                                                                     |
| CP06 replay onboarding               | Passed in isolated native/web evaluation | [Native base and cancel/reload holdout](cp06.v2.md) preserve all nine saved-data digests, account/watch state and native settings. Controlled startup/providers are explicit; stock release startup and real consent remain separate gates. |
| CP07 CI/CD                           | Blocked; deployed canary passed          | [Attempt a03](CP07-a03.json): final proxy CI, signed catalog/session isolation and all callback forms pass; protected-main deployment awaits review/merge.                                                                                  |

The [rollout plan](../../composio-proxy-rollout.md) is also included in [proxy PR #1](https://github.com/n8n-io/otto-composio-proxy/pull/1). New OAuth remains disabled. The user identified `otto-dev-internal-release` as the distributed key to retire in the release window; it has not been revoked.

## Findings before these cases were frozen

These are historical observations, not passing attempts under the frozen cases.

- Otto's reconnect-on-provider-change behavior conflicts with the new no-break upgrade requirement. A claimed old owner UUID or possession of a project-wide key is insufficient proof of individual account ownership.
- Composio's legacy upload request reused the same project object for identical checksums. Synthetic presign probes did not read any user's data.
- Deployed catalog requests failed because workerd rejects `redirect: "error"`. A real-runtime regression reproduced this; the candidate uses manual redirects and rejects non-success upstream responses.
- GitHub rejected the deployment workflow before creating any jobs. The file contains two identical `if` keys in the same job mapping.

## Preserved hypotheses from earlier attempts

| ID  | Red observation                                                                      | Hypothesis and prediction                                                                                                          | Evidence that would disprove it                                                                                    | Next change and retest                                                                                                                   |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| H01 | Existing rows become inactive after upgrade                                          | Shared provider ID plus a changed configuration fingerprint invalidates old rows; old account IDs must retain their original route | Old rows and operations remain active with their original project despite the switch                               | Design compatibility before editing; run CP02/03 base, holdouts and isolation regressions                                                |
| H02 | Deployment workflow has no jobs                                                      | Duplicate YAML job key makes GitHub reject the workflow                                                                            | Workflow parser accepts the duplicate and identifies another error                                                 | Remove duplicate, parse strictly, push, inspect exact-revision workflow checks                                                           |
| H03 | Live empty-session creation returns `400 invalid_request` after the catalog succeeds | The broker validates every catalog slug together; six unsupported slugs make session setup reject the entire catalog               | The exact SDK body fails validation before the catalog call, or every upstream slug satisfies the supported format | Parse the page envelope, then include only individually valid native rows; rerun the frozen signed live canary and mixed-catalog holdout |

Detailed attempts and sanitized evidence are appended beside this file. Original red evidence remains retained; changed checks require a new case version with a reason.

## Latest verified findings

- Configuration bootstrap now makes an authoritative owner/toolkit check before accepting an existing account under a changed key. Failed checks preserve local data and keep all account operations fenced. The unchanged frozen CP03 preflight passes both variants after its preserved red attempt; this is not legacy-to-hosted migration acceptance.
- The unchanged live canary passes on deployed proxy `994fc6d`: 221 catalog entries, signed owned empty-session creation/restore/delete, foreign read/delete denial, no project-key headers and sanitized MCP responses. Synthetic sessions/profiles were removed.
- Earlier literal loopback URLs hit Cloudflare managed rule `dfa84b0aed5a4b45b953a36a57035abf` before the Worker. The structured callback contract fixes the failing case: signed localhost, IPv4, IPv6 and HTTPS variants now reach the intentional OAuth-disabled JSON gate. No WAF exception or zone security change was needed. This is routing evidence, not real OAuth consent.
- CP06 proves the actual web renderer's replay and cancel behavior against synthetic APIs. Its native base remains blocked at the missing runtime pack; no full native preservation claim follows from the renderer holdout.

The CP06 runtime assets were later located in an existing internal Otto installation and passed their manifest integrity checks. They were not launched or copied. This removes an asset-discovery uncertainty, but does not establish a full native replay run: the engine still needs an isolated seeded database and controlled provider/model transport before acceptance can be scored.

## Final source scope

CP04 attempt a03 remains applicable to the Worker and signed SDK transport. A final dependency audit found all 19 imported local source files unchanged. Of its 31 recorded files, only `src/server/composition.ts` changed afterward (blank-key normalization); neither frozen SDK runner imports it. CP03.v2 separately re-evaluated that actual composition boundary on the updated source. CP02.v2 and CP05 cover the final server connection orchestration.

## Repository validation

The final application candidate passed `npm run check`, both web/native builds through `npm run test:integration`, and 769 integration tests with zero skips. `npm run desktop:test` passed 120 tests; the private-network workload-firewall test was skipped on this host. The final proxy revision `994fc6d` passed all 31 Worker tests and its [CI check](https://github.com/n8n-io/otto-composio-proxy/actions/runs/37818910493). Preserved failing attempts remain in the case records; later green runs do not replace them.
