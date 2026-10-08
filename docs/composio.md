# Connect apps with Composio

Otto connects to Gmail, Google Calendar, Drive, Sheets, Docs, Slack and many other apps through [Composio](https://composio.dev). You need your own Composio project and a project API key. Notion and Linear connect through their hosted MCP servers and need no Composio key. Other MCP servers, HTTP APIs and command-line tools use Otto's own discovery and secure setup flow.

## Create a project key

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

## Add the key to Otto

Paste the key in the onboarding email step, or in **Settings → Models** in the desktop app. Otto checks it with Composio and saves it encrypted with the Vault key. In a source install you can instead set `COMPOSIO_API_KEY` in `.env` and restart Otto. Then connect apps from **Apps**.

Permissions cannot be edited after creation; create a replacement key if one is missing. A valid key with insufficient permissions can produce an “Invalid API key” error. See Composio's [permission route map](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions) and [permission troubleshooting](https://docs.composio.dev/kb/guide/platform-project-api-key-permissions).

Keep using the same project's key. Connected accounts belong to that Composio project, so a key from another project cannot use them.

## Keep the key private

The key grants project-wide access. Anyone who has it, including anyone who can open the desktop app's settings, can use the project's permissions and connected accounts outside Otto. Use your own Composio project, and share a key only with people you would trust with every account connected to it. Otto's local encryption and owner IDs do not isolate a shared project key.

## App permissions

The key's permissions control what Otto can do in Composio. The Google or Slack consent screen separately controls what Otto can read or change in that account. The selected auth config controls app OAuth scopes; a `COMPOSIO_*_AUTH_CONFIG_ID` from `.env.example` explicitly selects that config. To narrow those grants, configure the required app scopes in that auth config and reconnect existing accounts; changing the project key does not change app consent. See [Controlling scopes](https://docs.composio.dev/docs/authentication/controlling-scopes).

When starting Gmail, Calendar, Drive, Sheets or Docs sign-in without an explicit override, Otto reads the project's auth configs and selects its one enabled custom OAuth2 config that is enabled for Tool Router. Explicit overrides win. Several eligible configs, or enabled custom OAuth2 configs with none available to Tool Router, stop sign-in with a configuration error. When no enabled custom OAuth2 config exists, Composio's project default applies. This lookup happens only during authorization and does not change existing accounts or other app flows.

## App catalog

The **Apps** page loads a searchable catalog of Composio integrations with managed authentication or dynamic OAuth registration. The agent uses the same catalog through `manage_apps discover`, then offers a private connection link. Catalog access requires **Toolkits → Read**; older keys without it keep their existing connections and featured apps. Native MCP toolkits with managed authentication or dynamic registration work through Composio.
