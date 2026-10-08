# Managed Composio rollout

Status: candidate deployed at `https://composio.n8n.cloud`; new OAuth connections remain disabled. This is a release checklist, not evidence that the release has passed. The [acceptance matrix](testing/composio-proxy/README.md) records measured results and remaining gaps.

## User-visible behavior

- Desktop always uses the managed proxy. Users never enter a Composio key.
- Servers use `COMPOSIO_API_KEY` when explicitly configured; otherwise they use the hosted proxy. A trusted custom proxy can be selected with `OTTO_COMPOSIO_PROXY_URL` outside packaged desktop.
- Existing direct desktop connections need a one-time reconnect. The same-project key change does not invalidate their grants; the new proxy cannot securely infer ownership from the old local UUID and shared key. There is no legacy provider or silent adoption of old account IDs.
- Existing direct server connections continue when the explicit key can access the same owned accounts. A revoked shared key cannot provide that continuity; customer-owned projects are unaffected by retirement of Otto's distributed keys.
- Reconnect must retain the selected local connection ID and watch preference after verified success, with no duplicate warning. Failure or cancellation must preserve the old local entry. A newly authenticated account starts a fresh inbox cursor; the interruption interval is not recovered automatically.
- Webhooks are outside this rollout. Managed Gmail polling remains covered by integration tests.

Suggested release note: “App connections now use Otto's managed service. If an existing connection asks you to reconnect, open Apps and reconnect that account once. No Composio setup is needed. Server operators can continue using their own project with `COMPOSIO_API_KEY`.”

## Prepare before activation

1. Finish final-source checks for both repositories and obtain review. Merge the proxy PR through protected main and verify its production workflow deploys the intended SHA. A manual candidate deployment does not prove CI deployment.
2. Keep `OAUTH_VERIFIER_ENABLED=false` in committed configuration during preparation. Verify keyless catalog, signed empty-session create/restore/delete, foreign-owner denial, redaction, and all three loopback callback forms plus HTTPS against the deployed candidate.
3. Confirm the operator-selected auth configs in `otto_hosted` belong to the expected toolkit and OAuth application. Reuse existing custom Google configs. Automatic creation is limited to eligible managed/DCR configs requiring no operator input; do not replace working client credentials or scopes during this rollout.
4. The user identified `otto-dev-internal-release` as the distributed key (dashboard creation time: 2026-10-06 12:34 UTC). Match that exact entry at cutover and obtain final retirement approval. The other four pre-existing keys are outside the retirement scope. The new `otto-composio-proxy` key stays in Cloudflare; installations must never receive it. Existing distributed keys can bypass proxy ownership checks until revoked.
5. Prepare the matching desktop release and a dedicated synthetic provider account for manual consent acceptance. Complete native onboarding replay with an isolated runtime/database. A fixture or health check cannot replace actual consent/native acceptance.
6. Confirm operational abuse limits and project spending alerts. Signatures identify an installation, not an official build or one human; anonymous clients can generate additional keys. Cloudflare counters are per location, not a hard global budget. Logs must not retain callback tokens or request bodies.

## Activate in one controlled window

1. Hold desktop auto-updates until these gates are ready. Communicate the one-time reconnect and interruption to older clients before retiring their shared keys.
2. Revoke only the approved `otto-dev-internal-release` key and verify it no longer authorizes Composio requests. Keep the Worker key and explicitly approved server-only keys. Do not delete existing connected accounts or provider grants.
3. Set the `otto_hosted` project callback identity verifier to `https://composio.n8n.cloud/v1/connect/callback` and read back the setting. This is project-wide: older clients can no longer complete new or repeated connections.
4. Merge the activation configuration setting `OAUTH_VERIFIER_ENABLED=true` and verify main deploys that exact revision. Keeping the flag in Git prevents a later deployment silently undoing activation.
5. Using the prepared synthetic provider account, complete browser pairing and consent from the release candidate. Verify ownership, second-installation denial and a permitted read against the intended account. Separately exercise an HTTPS server callback. Do not send mail or other outside messages as part of acceptance.
6. Test an upgraded disposable profile through reconnect, restart and a permitted read; confirm the stable local connection, retained watch preference and absence of the old warning. Exercise cancel/retry and the explicit-server-key path. Publish only after these checks pass.

## Required evidence

| Scenario                                                 | Required result                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Fresh desktop and keyless server                         | Catalog and connection without a Composio setup prompt; callback reaches the correct instance.          |
| Existing desktop with saved/environment key              | Old key ignored; old connection fenced; verified reconnect produces one usable local entry.             |
| Server with explicit key; same-project rotation          | Direct transport, unchanged owner/account and preserved cursor/watch/queued work; no consent requested. |
| Server without a key; trusted custom proxy               | Managed transport and persistent per-owner identity; no implicit UI-stored-key fallback.                |
| Cancelled, failed, wrong-account or superseded reconnect | Original local data retained; no foreign access, old-grant deletion or stale completion.                |
| Two installations and simultaneous requests              | Ownership, signature, callback and replay checks reject substitutions.                                  |
| Workspace attachment                                     | Exact bytes, isolated file reference and owner/account/action fencing; bounded large-file path.         |
| Replay onboarding                                        | Full native/product flow and development-only web replay preserve data.                                 |
| CI/CD                                                    | Final-SHA checks plus protected-main deployment; credentials absent from artifacts.                     |

Automated tests use synthetic data and controlled transports. Live checks so far cover task-created Composio sessions/files, not provider-account consent or delivery. Retain that distinction in the release PR.

## Rollback

- Before verifier/key changes: keep OAuth disabled, stop the app release and redeploy the last validated candidate if necessary. No user grants require rollback.
- After activation: disable new OAuth through the committed Worker flag and pause the app release. Restore only a known compatible Worker/app revision that retains installation-key storage and ownership checks. Do not roll back to a version that distributes project keys.
- Never re-enable a retired shared key or disable the verifier merely to make an old client work. A provider reconnect may still be required after rollback.
- Preserve local databases and installation signing keys. Rotating the Worker encryption secret invalidates pending consent/file capabilities; rotating its Composio key alone does not change installation identities. Never retry uncertain tool execution automatically.
- Stop rollout for cross-owner data exposure, unexpected grant deletion, failed reconnect preservation or broken consent. Preserve the evidence and fix the general cause before repeating the frozen case.
