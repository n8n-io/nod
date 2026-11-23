---
title: App format reference
description: The supported Agent Plugins fields, Nod extension, and mandatory contract fixture.
sidebar:
  order: 6
---

Every shipped app must pass the Agent Plugins schemas and Nod's app profile.

## Standards used

| Standard                                                                       | Purpose                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [Agent Plugins 1.0.0](https://agent-plugins.org/specification)                 | Folder layout, manifest, MCP configuration, and client extensions |
| [Model Context Protocol](https://modelcontextprotocol.io/specification/latest) | Tool discovery, calls, responses, and OAuth setup                 |
| [Agent Skills](https://agentskills.io/specification)                           | Optional instructions and reference files                         |
| [Semantic Versioning](https://semver.org/)                                     | App definition versions                                           |

Nod adds display fields, typed connection bindings, private setup choices, required fixtures, and approval rules. Version one includes MCP, API, and CLI bindings. The app card, Connect flow, and public page use one app model. A plugin for another client can use features outside this profile. Check this reference before copying a Codex or Claude plugin.

The API and CLI bindings use these standards and conventions:

- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) for strict editor and runtime contracts.
- [HTTP semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) for API methods and status codes.
- [Bearer tokens, RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) and [OpenAPI security schemes](https://spec.openapis.org/oas/v3.2.1.html#security-scheme-object) for HTTP authentication terms and headers.
- [OAuth security practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), S256 PKCE, and [RFC 8414 metadata](https://www.rfc-editor.org/rfc/rfc8414.html) for browser sign-in.
- Separate argument vectors, stdout, stderr, and exit status for CLIs. The [Command Line Interface Guidelines](https://clig.dev/) describe these conventions.

HTTP and CLI bindings are Nod extension fields. They are not additional features of the Agent Plugins standard. Nod uses its existing API transport and sealed CLI runner.

## Folder and package identity

Use `src/apps/<app-id>/plugin.json`. The folder and manifest `name` must match. Nod app IDs use two to 40 lowercase letters, digits, or single hyphens. Start with a letter and end with a letter or digit. Agent Plugins itself permits a broader name format.

Set `$schema` to `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`. Nod also requires a semantic `version` and a non-empty `description` of up to 1,000 characters.

Set `author.name` to the maintainer's public name or organization. Complete every generated placeholder before submission.

The standard root fields are `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, and `extensions`. Shipped app checks reject unknown root fields. Set the Nod extension to this fixed reference:

```json
{
  "io.n8n.nod": { "app": "./io.n8n.nod/app.json" }
}
```

This object is the value of `extensions`. Nod settings live in `io.n8n.nod/app.json`. The standard manifest keeps its official `$schema` value.

The canonical schemas are bundled in `src/server/agent-plugins/`. The loader does not download schemas. Schema sources are the [manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) and [MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json).

## Nod extension

The required `io.n8n.nod/app.json` starts with `"$schema": "https://nod.n8n.io/docs/schemas/apps/v1/app.schema.json"`.

The [app schema](https://nod.n8n.io/docs/schemas/apps/v1/app.schema.json) and [fixture schema](https://nod.n8n.io/docs/schemas/apps/v1/contract.schema.json) are versioned JSON Schema documents. Editors can read them directly. Their source is `src/shared/app-definitions.ts`, which also supplies TypeScript types and runtime validation.

| Field          | Requirement                                                          |
| -------------- | -------------------------------------------------------------------- |
| `$schema`      | Required app profile v1 schema URL                                   |
| `displayName`  | Required display name on one line, up to 80 characters               |
| `icon`         | Optional path under `./io.n8n.nod/`; SVG, PNG, or WebP, up to 128 KB |
| `categories`   | Optional array of up to 10 category names                            |
| `prompts`      | Two to four concrete example requests                                |
| `requirements` | One to eight account, plan, scope, or version requirements           |
| `limitations`  | One to eight statements of unsupported or restricted behavior        |
| `connection`   | Required typed MCP, HTTP API, or CLI connection definition           |

Unknown fields and unsupported connection combinations fail validation. Other client extension namespaces keep their own meaning. A profile version change requires an explicit migration.

Text fields must contain visible text. Do not start or end them with whitespace. The display name can't contain control or format characters or line separators, such as line breaks or text direction marks.

The published schema files are generated. `pnpm check:apps` fails if they differ from their TypeScript source. Maintainers update them with `pnpm generate:app-schemas` when the profile changes.

## Fixed MCP address

Select one named server from `mcp.json`:

```json
{
  "type": "mcp",
  "server": "my-app",
  "authentication": ["oauth2"],
  "scopes": ["read"]
}
```

The `scopes` field is optional and is valid only with `oauth2`. Its limits are under [OAuth scopes](#oauth-scopes). Fixed connections select one authentication method: `oauth2`, `bearer`, or `x-api-key`. Nod sends API keys in `X-API-Key`.

`mcp.json` must target the matching Agent Plugins schema version. It must contain exactly one server, named as in the connection's `server` field, with `type: "streamable-http"`. Its address must be public HTTPS without credentials, a query, or a fragment. DNS and network checks also run when Nod connects.

Static headers, stdio servers, and legacy SSE servers are outside the current Nod app profile. A schema-valid Agent Plugin can still use features Nod does not support.

## Owner-supplied instance

Use this connection shape and omit `mcp.json`:

```json
{
  "type": "mcp",
  "endpoint": {
    "source": "owner",
    "path": "/mcp-server/http"
  },
  "authentication": ["oauth2", "bearer"]
}
```

The path contains slash-separated letters, digits, underscores, and hyphens. Nod appends it to the address the user enters. Use the authentication tuple in the order shown. Fixed scopes are not supported for this setup.

Nod applies its address policy outside the manifest. Only n8n has the existing local-address exception and fixed localhost probe. Tokens go only to the saved address.

## HTTP API and CLI bindings

Use `type: "http"` with a public HTTPS `url`. Select one authentication method: `oauth2`, `bearer`, or `x-api-key`. Only API-key connections accept `apiKeyHeader`. Only OAuth connections accept `scopes`, `oauth`, and `clientIdRequired`.

Use `type: "cli"` with `command`, a pinned `source`, `authentication: ["env"]`, and an `environment` label map. The map contains one to 16 fields. Names have at most 64 characters. The CLI fixture supplies the read check and its timeout.

API and CLI folders omit `mcp.json`. Unknown fields, extra transports, app-folder install scripts or hooks, static secrets, control headers, and mismatched read fixtures fail the required checks. The sealed installer can run package install scripts from the declared CLI source before it adds credentials.

Fixed server addresses and CLI download addresses must use public HTTPS on port 80 or 443. OAuth endpoints use port 443. Owner-supplied n8n instance addresses follow the separate instance policy.

See the complete [API and CLI examples](/contribute/apps/api-and-cli/).

## OAuth scopes

Fixed MCP and HTTP API connections that use `oauth2` share the same `scopes` limits: up to 30 scopes of up to 100 characters each, and at most 500 characters when joined with spaces. Editors don't check the joined length; `pnpm check:apps` does.

## Connect form hints

A connection can add `hints`: one short line, up to 200 characters, shown under a field of the Connect form. Use a hint to say where the user finds the value.

```json
{
  "hints": {
    "token": "Copy this token from Settings → Instance-level MCP in your n8n instance."
  }
}
```

The keys name the fields that connection asks for. Any other key fails validation.

| Connection                                     | Hint keys                      |
| ---------------------------------------------- | ------------------------------ |
| Owner-supplied instance                        | `address`, `token`             |
| Fixed MCP or HTTP with `bearer` or `x-api-key` | `token`                        |
| HTTP with `oauth2`                             | `clientId`                     |
| CLI                                            | The names in its `environment` |

A hint is fixed text from the app definition. It contains no value, and Nod shows it only for the connection the app defines.

## Required contract fixture

Every folder includes `io.n8n.nod/contract.json`:

```json
{
  "$schema": "https://nod.n8n.io/docs/schemas/apps/v1/contract.schema.json",
  "source": "https://provider.example/docs/mcp",
  "tool": {
    "name": "find_records",
    "description": "Find records by a query.",
    "inputSchema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"]
    },
    "annotations": { "readOnlyHint": true }
  },
  "input": { "query": "synthetic example" },
  "output": { "records": [{ "id": "synthetic-record" }] }
}
```

Use a documented read tool. `input` must match its schema. `output` must contain synthetic JSON data. Objects, arrays, strings, numbers, booleans, and null are supported. The read-only hint describes the fixture; it does not bypass Trust.

The tool name must have one to 100 characters and must not start with `replace_`. The description must have one to 2,000 characters. Set `inputSchema.type` to `object`. The framework validates it as JSON Schema 2020-12. It then checks the sample input against every declared constraint, including patterns.

This is the MCP fixture. Set `type: "mcp"` in new fixtures. Older v1 MCP fixtures without `type` remain valid. API fixtures use `type: "http"` and a `request`. CLI fixtures use `type: "cli"`, `argv`, `format`, and `timeoutSeconds`. See [API and CLI examples](/contribute/apps/api-and-cli/).

The fixture must match the connection type. The loader also validates the normalized setup with the runtime access-path schema. Offline checks do not prove external availability. Provider acceptance remains required.

## Optional skills

Put each skill in `skills/<skill-name>/SKILL.md`, with Agent Skills frontmatter. Files must remain inside their skill directory after link resolution. The current loader supports Markdown guides and references. It does not install or execute skill scripts.

## Related resources

- [Build an app for Nod](/contribute/apps/)
- [Test the app](/contribute/apps/test/)
- [Agent Plugins specification](https://agent-plugins.org/specification)
