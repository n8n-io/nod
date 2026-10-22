# Public app connections: implementation and validation

Date: 2026-10-22. Proxy commit `8c590af` is deployed to the existing Worker as version `87b83ad6-31d2-43b3-975b-9f2e08d91dab`. Proxy PR #1 is updated. Remote readback and manual Gmail acceptance are in progress.

## Implementation

Otto always uses the v2 Composio proxy. It creates an Ed25519 installation identity, encrypts the private key using its existing vault encryption root, and retains it in the persistent profile. The desktop root is protected through Electron's operating-system-backed secure storage. The public identifier alone cannot authorize a request. The proxy verifies signatures, replay protection, admitted account ownership and exact session/account selection.

Google admission, email/domain allowlists, personal Composio keys, configuration switching and account adoption are removed from the new Otto client and v2 protocol. Onboarding connects Gmail directly; actual account management remains in Apps. Upgrades from the previous connection configuration require fresh app consent and preserve other local data. Subsequent updates retain the encrypted identity.

The existing `otto-composio-proxy` Worker, D1 database and Composio project are reused. The new `/v2/*` protocol runs alongside the existing v1 endpoints so older installed clients keep their current behavior. Compatibility remains only in the proxy; the new Otto client has no old setup flow. An additive database migration preserves old grants and replay claims. The existing project callback URL remains unchanged, with distinct cookies and sealed token purposes routing new callbacks without weakening old Google checks.

The browser bridge supports Otto's documented same-computer desktop and source installations. It uses an isolated loopback listener for each consent attempt. A browser on another computer cannot use this bridge; remote or hosted browser access is outside Otto's supported local-only setup.

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
| Proxy types, synthetic tests and Wrangler dry run                     | Passed; 209/209 tests                                                |
| Actual Chrome with both repositories' adapters and synthetic provider | Passed the shared callback flow without Turnstile                    |

The latest Chrome run used the actual Otto adapter and proxy runtime with a synthetic provider. It passed signed enrollment, browser-key proof across redirects, the shared `/v1/connect/callback`, exact account admission, SDK session creation, pinned-account execution and identity reuse after adapter restart. The loopback bridge closed after completion. The receipt is `/tmp/otto-cross-contract/evidence-coexist.json`; this is not live provider or OS-backed identity acceptance.

An earlier large-metadata run failed because a sealed cookie exceeded browser limits. The repaired state omits display metadata and redundant encrypted nesting; the same browser flow then passed with an 860-byte pairing cookie.

Final review reproduced a disconnect defect: removing admission before upstream deletion could turn a provider timeout into a false success on a later retry. The corrected proxy retains a blocked revocation record until deletion or upstream absence is confirmed. Ordinary inspection and execution return a conflict while revocation is pending; only an explicit owned deletion can recover. Permanent revoked records prevent the same account ID being admitted again. The failing regression and corrected results are retained under `.local/public-integrations-validation/`.

Onboarding, Apps and Settings were visually reviewed using synthetic data. Before/after screenshots are retained locally under `.local/composio-ui-review/`. Browser protocol receipts are under `.local/public-integrations-validation/`.

The isolated macOS Electron probes completed encryption/decryption and identity signing in one process, but their harness failed to find its expected uniquely named Keychain item and stopped before restart. An earlier renamed bundle was not actually packaged; the final corrected bundle proved it was packaged, had a unique app name and had mock Keychain disabled, but still failed the isolation assertion. All four failure receipts remain under `.local/composio-identity-acceptance/`, including `macos-restart-packager.json`. They do not establish OS-backed restart or packaged-update acceptance. Temporary bundles and profiles were removed; no shared Keychain entry was directly modified or deleted. Updated native updater fixtures exercise encrypted identity continuity, but have not been run through actual macOS/Windows installers in this session.

## Remaining acceptance and rollout

The existing Worker was deployed without creating a new service. Remote readback of its routes and configuration is pending. Synthetic coexistence checks preserve old Google admission and reject mixed cookies or cross-version completion tokens before provider activation. Manual Gmail acceptance is in progress; no real Gmail authentication or provider action is claimed yet.

Composio's `complete_auth` activates a session before returning its connected account ID. The proxy admits only the expected account, toolkit, owner and auth configuration and denies unexpected accounts on subsequent reads, sessions and execution. It cannot roll back an unexpected upstream activation or guarantee same-attempt provider-session continuity. This provider boundary is deliberately tested and documented in the companion proxy README. Live verification and an explicit risk decision remain necessary before public rollout.
