# Upgrade decision

Decision recorded on 2026-10-08: keep the managed project `otto_hosted`, do not add a legacy transport or migration certificate, and explicitly tell users if reconnecting is required. Servers continue to support `COMPOSIO_API_KEY`; absent that environment variable, they use the hosted proxy.

| Installation                            | Upgrade behavior                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Packaged desktop with an old saved key  | Uses the proxy. Existing direct connections require a one-time reconnect.                                        |
| Server with an explicit environment key | Remains direct. Existing owned accounts survive a key rotation within the same project.                          |
| Server without an environment key       | Uses the proxy. An old key saved through the UI is not loaded; previous direct connections require reconnecting. |
| Installation already using the proxy    | Keeps its signing identity across restarts and continues using existing proxy connections.                       |

Changing API keys within one Composio project does not itself require a new provider grant. The desktop problem is ownership admission: the old app stored an independent random owner UUID and a project-wide key, with no remotely verifiable binding to the new installation signing key. A caller could claim somebody else's UUID with the same shared key. The proxy therefore accepts only its signing-key-derived user ID. [Project key permissions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions).

Reconnect creates a connection owned by the new identity. The provider may reuse the person's existing browser login, but Otto cannot promise that the provider will skip consent. The old provider grant is not revoked merely by starting the upgrade or reconnect.

## General configuration handling

Startup checks the authoritative account owner and toolkit before accepting a changed configuration fingerprint. Success preserves the connection, watch preference, polling cursor and queued events. Failure preserves local data but fences execution, email lookup, polling, event delivery and stale callbacks. Old sessions are not restored through a changed configuration.

A reconnect through a changed configuration must replace the selected local binding only after the new account is verified, retain its local ID and watch preference, and leave the old remote grant untouched. Failed or cancelled consent must leave the old entry available for recovery. Obsolete polling cursors and queued work cannot be applied to the new account. This is normal provider-change handling, not a second legacy provider.

The original CP02/CP03 version-one no-reconnect expectations and failed/blocked evidence remain in [cases.v1.json](cases.v1.json). [Version two](cases.v2.json) reflects the user's later decision; it does not relabel historical outcomes as passes. Same-project direct-key preservation has an unchanged [red](CP03-preflight-red.json) and [green](CP03-preflight-green.json) preflight.

## Release boundary

All distributed project-wide `otto_hosted` keys must be retired before accepting new managed users. Otherwise their holders can bypass the Worker and access accounts in the same project. Keep trusted server-only operational keys separate. First record the exact key IDs, consumers and operator-approved retirement list; do not revoke unspecified keys blindly.

The Composio callback identity verifier applies to the whole project and prevents older clients from completing new sign-ins. Existing active grants are not deleted by that setting. Coordinate verifier activation, the Worker and the desktop release. [Deferred OAuth completion](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth).

The [rollout plan](../../composio-proxy-rollout.md) gives the activation order, acceptance gates and rollback limits. No existing user key has been revoked, no project-wide verifier has been enabled, and no desktop release has been published during this work.
