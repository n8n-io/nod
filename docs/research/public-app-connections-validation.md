# Public app connections: implementation and validation

Date: 2026-10-22. Proxy commit `add755f` is deployed to the existing Worker as version `860acb71-7584-4a60-8c36-4927981fc815`. Proxy PR #1 is updated. Production readback passed; manual Gmail acceptance awaits the user's n8n Okta verification.

## Implementation

Otto always uses the v2 Composio proxy. It creates an Ed25519 installation identity, encrypts the private key using its existing vault encryption root, and retains it in the persistent profile. The desktop root is protected through Electron's operating-system-backed secure storage. The public identifier alone cannot authorize a request. The proxy verifies signatures, replay protection, admitted account ownership and exact session/account selection.

Google admission, email/domain allowlists, personal Composio keys, configuration switching and account adoption are removed from the new Otto client and v2 protocol. Onboarding connects Gmail directly; actual account management remains in Apps. Upgrades from the previous connection configuration require fresh app consent and preserve other local data. Subsequent updates retain the encrypted identity.

The existing `otto-composio-proxy` Worker, D1 database and Composio project are reused. The new `/v2/*` protocol runs alongside the existing v1 endpoints so older installed clients keep their current behavior. Compatibility remains only in the proxy; the new Otto client has no old setup flow. An additive database migration preserves old grants and replay claims. The existing project callback URL remains unchanged, with distinct cookies and sealed token purposes routing new callbacks without weakening old Google checks.

The browser bridge supports Otto's documented same-computer desktop and source installations. It uses an isolated loopback listener for each consent attempt. A browser on another computer cannot use this bridge; remote or hosted browser access is outside Otto's supported local-only setup.

Startup reads project supported settings into memory without rewriting the existing settings file. This preserves the earlier version’s readable settings if an update fails before readiness; a later owner preference save writes the current schema. A regression covers failed key-store unlock and unchanged vault ciphertext.

The user explicitly declined Turnstile, and it has been removed. Browser-key pairing proves possession of a key, not a human identity. Atomic installation, source and global budgets plus concurrency leases protect shared capacity. Defaults allow 100,000 upstream calls per installation per day and 1,200 per minute. These are request ceilings, not an exact billing ceiling.

## Completed checks

| Check                                                                 | Result                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Otto types, architecture and formatting                               | Passed                                                               |
| Otto local deterministic suite                                        | 225 passed, 110 environment-dependent skips                          |
| Otto Linux integration suite with disposable PostgreSQL and Chromium  | 537 passed, no failures or skips                                     |
| Production web and desktop UI build                                   | Passed as part of the integration command                            |
| Desktop suite                                                         | 177 passed; Linux firewall and Windows DPAPI checks skipped on macOS |
| Documentation build and links                                         | Passed                                                               |
| Proxy types, synthetic tests and Wrangler dry run                     | Passed; 215/215 tests                                                |
| Actual Chrome with both repositories' adapters and synthetic provider | Passed the shared callback flow without Turnstile                    |
| Production deployment and unauthenticated boundaries                  | Passed; expected version serves 100% of traffic                      |

The latest Chrome run used the actual Otto adapter and proxy runtime with a synthetic provider. It passed signed enrollment, browser-key proof across redirects, the shared `/v1/connect/callback`, exact account admission, SDK session creation, pinned-account execution and identity reuse after adapter restart. The loopback bridge closed after completion. The receipt is `/tmp/otto-cross-contract/evidence-coexist.json`; this is not live provider or OS-backed identity acceptance.

An earlier large-metadata run failed because a sealed cookie exceeded browser limits. The repaired state omits display metadata and redundant encrypted nesting; the same browser flow then passed with an 860-byte pairing cookie.

Final review reproduced a disconnect defect: removing admission before upstream deletion could turn a provider timeout into a false success on a later retry. The corrected proxy retains a blocked revocation record until deletion or upstream absence is confirmed. Ordinary inspection and execution return a conflict while revocation is pending; only an explicit owned deletion can recover. Permanent revoked records prevent the same account ID being admitted again. The failing regression and corrected results are retained under `.local/public-integrations-validation/`.

Onboarding, Apps and Settings were visually reviewed using synthetic data. Synthetic before/after comparisons are included for [email onboarding](public-app-connections/email-before-after.webp), [Apps](public-app-connections/apps-before-after.webp) and [Settings](public-app-connections/settings-before-after.webp). Original screenshots are retained locally under `.local/composio-ui-review/`. Browser protocol receipts are under `.local/public-integrations-validation/`.

The isolated macOS Electron probes completed encryption/decryption and identity signing in one process, but their harness failed to find its expected uniquely named Keychain item and stopped before restart. An earlier renamed bundle was not actually packaged; the final corrected bundle proved it was packaged, had a unique app name and had mock Keychain disabled, but still failed the isolation assertion. All four failure receipts remain under `.local/composio-identity-acceptance/`, including `macos-restart-packager.json`. They do not establish OS-backed restart or packaged-update acceptance. Temporary bundles and profiles were removed; no shared Keychain entry was directly modified or deleted. Updated native updater fixtures exercise encrypted identity continuity, but have not been run through actual macOS/Windows installers in this session.

The read-only follow-up confirmed that [Electron 44.5.0 captures the Keychain service and account names during startup](https://github.com/electron/electron/blob/v44.5.0/shell/browser/electron_browser_main_parts.cc). The temporary probe source and lookup OSStatus were not retained, so the lookup failure's cause remains undetermined. The existing disposable-runner native update check can test two separate packaged processes, retaining ciphertext hashes, the same public identity and independently verified signatures; a manual CI job now runs it on a disposable macOS runner alongside the existing Windows updater check. Those final native results are pending.

## Remaining acceptance and rollout

Production readback confirmed the expected Worker version at 100% traffic, public v2 enabled, all three D1 migrations, 27 enabled old grants and expected health, authentication and callback responses. The receipt is `.local/public-integrations-validation/production-read-only-add755f.json`. It made no signed requests, registrations or connected-provider calls. Synthetic coexistence checks preserve old Google admission and reject mixed cookies or cross-version completion tokens before provider activation. The final proxy review fixes verify a signed body digest before accepting upload capacity, keep access revocation independent of provider secrets and enforce session toolkit restrictions during execution. Five regressions failed against the preceding commit and pass with the fixes; the combined suite passes all 215 tests. Final deployment readback passed, including immediate rejection of an unsigned upload without reading a body. The preceding CI run exposed an unrelated randomized negative-test collision; its failure receipt is retained and the fixture is being made deterministic.

Manual Gmail acceptance is waiting for the user's n8n Okta verification; no completed Gmail authentication or provider action is claimed yet. The desktop release remains unreleased pending live Gmail and native identity acceptance.

Composio's `complete_auth` activates a session before returning its connected account ID. The proxy admits only the expected account, toolkit, owner and auth configuration and denies unexpected accounts on subsequent reads, sessions and execution. It cannot roll back an unexpected upstream activation or guarantee same-attempt provider-session continuity. This provider boundary is deliberately tested and documented in the companion proxy README. The user authorized the existing Worker deployment after this limitation was disclosed.
