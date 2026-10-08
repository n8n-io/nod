# Connect apps with Composio

Otto connects to Gmail, Google Calendar, Drive, Sheets, Docs, Slack and many other apps through [Composio](https://composio.dev). Open **Apps**, choose an app, compare the sign-in code with the browser, and approve the service permissions. You do not need an Otto signup, a Composio account, or a project key. Notion and Linear connect through their hosted MCP servers. Other MCP servers, HTTP APIs and command-line tools use Otto's own discovery and secure setup flow.

## Managed connections

Desktop and source installs use `https://composio.n8n.cloud` by default. Each local profile has a private signing key under `OTTO_DATA_ROOT/integration-identity`, outside the sandbox. The proxy verifies signed requests and keeps the Composio project key server-side. Composio stores the authorized service connections and refreshes their credentials.

Keep the data folder when backing up or moving an installation. Losing its integration identity requires connecting those apps again. This identity is specific to the installation; it does not provide cross-device account recovery.

Hosted tenant runtimes derive separate integration identities from each owner's stable vault key, so replacing a runtime preserves its connected apps. The derived key remains in the trusted tenant process and is never written into the workspace or browser.

The candidate packaged desktop app uses the proxy and ignores old saved Composio keys. Source/server installs can set `OTTO_COMPOSIO_PROXY_URL` to a trusted custom proxy, or explicitly set `COMPOSIO_API_KEY` to use their own project directly. HTTPS is required except for a loopback development proxy. On a configuration change, Otto checks each existing account's owner and toolkit before allowing access. A failed check preserves its local connection, polling cursor, watch settings and queued events but keeps operations unavailable. Old provider sessions are not reused across configurations. Removing an unverified local entry does not revoke its grant in the previous project.

Existing direct desktop connections require a one-time reconnect: their ownership cannot be securely inferred from a local UUID and shared project key. No legacy transport is retained. Servers with an explicit key continue directly, and same-project key rotation preserves verified accounts. The [upgrade decision](testing/composio-proxy/upgrade-review.md) and [rollout plan](composio-proxy-rollout.md) describe release gates and coordinated activation.

The proxy processes integration requests and results. Composio's own [data-retention policy](https://docs.composio.dev/docs/security/data-retention) still applies; a proxy without account storage does not remove the provider's retained data.

Workspace files up to 15 MB travel through the proxy to isolated Composio session storage. The app receives an encrypted attachment reference bound to its installation and action. The proxy keeps writable storage URLs and raw file keys private. Composio's project-wide MD5 upload route and caller-supplied storage keys remain blocked. See the [upload isolation contract](research/composio-managed-upload-contract.md) for the verified provider behavior and cleanup limits.

Files remain available through pending approvals and uncertain executions. Composio documents automatic deletion from this temporary storage after 24 hours; this retention policy has not been verified by a live 24-hour check. Otto does not delete an attachment when an action times out, because the provider may still be using it.

## Use your own project on a source/server install

In the [Composio Dashboard](https://dashboard.composio.dev), open **Platform → your project → Settings → API Keys → Create API Key** and create a scoped project key with these permissions:

| Permission area        | Access         | Used by Otto                                                                     |
| ---------------------- | -------------- | -------------------------------------------------------------------------------- |
| Connected accounts     | Read and write | Check connections and disconnect accounts                                        |
| Session management     | Read and write | Create, restore and delete sessions; open app sign-in links                      |
| Session tool execution | Write only     | Find app actions, load their schemas and run them                                |
| Toolkits               | Read only      | Discover available integrations before connecting an account                     |
| Auth configs           | Read only      | Select the project's custom Google OAuth config when no explicit override exists |
| Proxy execute (Legacy) | Write only     | Read account identity, check Gmail updates and retrieve requested sign-in emails |

Auth configs read is needed only for automatic Google auth-config selection; explicit overrides and other apps do not use that lookup. Leave **Tools**, **Triggers**, **Webhooks**, **Observability**, **MCP (Legacy)** and **Tool execution (Legacy)** at **No access**. If you configure `COMPOSIO_WEBHOOK_SECRET` for automatic app updates, also grant **Triggers → Read and write**: the SDK reads trigger definitions before creating subscriptions, and Otto removes subscriptions when disconnected. Otto does not manage Composio webhook endpoints through the API.

The table covers the calls [Otto's adapter](../src/providers/composio/integrations.ts) makes with `@composio/core` 0.21.0.

Set `COMPOSIO_API_KEY` in the source/server install's `.env` and restart Otto. Keys previously entered through the UI are no longer loaded. Then connect apps from **Apps**.

Permissions cannot be edited after creation; create a replacement key if one is missing. A valid key with insufficient permissions can produce an “Invalid API key” error. See Composio's [permission route map](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions) and [permission troubleshooting](https://docs.composio.dev/kb/guide/platform-project-api-key-permissions).

Rotating a key within the same project preserves accounts after Otto verifies their owner and toolkit. A key from another project cannot use those accounts. Failed verification leaves their saved state intact and is attempted again on the next runtime startup.

## Keep the key private

The key grants project-wide access. Keep a customer-owned key only in that customer's trusted runtime; do not distribute it to independent users. Otto's managed proxy keeps its shared project key off user installations.

## App permissions

The key's permissions control what Otto can do in Composio. The Google or Slack consent screen separately controls what Otto can read or change in that account. The selected auth config controls app OAuth scopes; a `COMPOSIO_*_AUTH_CONFIG_ID` from `.env.example` explicitly selects that config. To narrow those grants, configure the required app scopes in that auth config and reconnect existing accounts; changing the project key does not change app consent. See [Controlling scopes](https://docs.composio.dev/docs/authentication/controlling-scopes).

When starting Gmail, Calendar, Drive, Sheets or Docs sign-in in direct mode without an explicit override, Otto reads the project's auth configs and selects its one enabled custom OAuth2 config that is enabled for Tool Router. Explicit overrides win. Several eligible configs, or enabled custom OAuth2 configs with none available to Tool Router, stop sign-in with a configuration error. When no enabled custom OAuth2 config exists, Composio's project default applies. This lookup happens only during authorization and does not change existing accounts or other app flows.

## App catalog

The **Apps** page loads a searchable catalog of Composio integrations with managed authentication or dynamic OAuth registration. The agent uses the same catalog through `manage_apps discover`, then offers a private connection link. Catalog access requires **Toolkits → Read**; older keys without it keep their existing connections and featured apps. Native MCP toolkits with managed authentication or dynamic registration work through Composio.
