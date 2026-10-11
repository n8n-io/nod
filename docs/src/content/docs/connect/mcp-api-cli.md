---
title: MCP servers, APIs and CLIs
description: Connect Notion and Linear directly, and let Otto set up other services through an MCP server, an HTTP API or a command-line tool.
sidebar:
  order: 3
---

Besides [Composio apps](/connect/apps/), Otto connects to Notion and Linear directly. For other services, it can set up an MCP server, an HTTP API or a command-line tool (CLI).

## Notion and Linear

Notion and Linear connect through their own hosted MCP servers. You sign in with OAuth, and you don't need a Composio key. Open **Apps** and select **Connect**.

Otto's direct Linear connection uses Linear's read-only MCP endpoint.

## Connect another service

Ask Otto to connect a service it can't find in the app catalog. Otto proposes a way in, called an access path, and sends you a link to a private setup page. There, you paste a token or sign in. The model never sees the token.

| Access path | What Otto calls                    | How it signs in                       |
| ----------- | ---------------------------------- | ------------------------------------- |
| MCP server  | Tools on a public HTTPS MCP server | A token in a header, or OAuth sign-in |
| HTTP API    | A method and path on the API       | A token in a header                   |
| CLI         | A command with arguments           | One token in an environment variable  |

Otto keeps the token encrypted in Vault, and the server adds it to each call. A file returned by the service that contains the token is withheld.

## How connected CLIs keep the token safe

A CLI path declares where to install the tool from:

- an npm package,
- a PyPI package, installed with `pipx`, or
- an HTTPS download of a release program or archive, with an optional `sha256` checksum.

The setup page shows that source next to the token field, so you can check it before you paste the token.

```mermaid
flowchart LR
  source[Declared source<br/>npm · PyPI · HTTPS] -- installs --> sealed[(Sealed install)]
  sealed --> runner[Runs as<br/>otto-connected]:::go
  token[(Token in Vault)]:::accent -- one variable --> runner
  files[Workspace files]:::muted -. as arguments .-> runner
  runner -- text output --> otto[Otto]
```

Otto installs the tool as a separate user, `otto-connected`, in a folder the workspace user can't write. Each run gets an environment built from scratch: a `PATH` with the sealed tool and system folders, a private temporary home and the one token variable.

Nothing comes from the workspace user's files or settings. A program that the model writes or replaces in the workspace never receives the token. You can still pass workspace files as arguments, and the CLI returns text.

## Send and receive files

To attach a workspace file to a Composio action, Otto passes `{workspaceFile, mimeType, name?}`. The server reads and checks the files, then uploads them. Files in one action can total 15 MB. If the action waits for your approval, the attachment can't change in the meantime.

Files that apps send back are saved privately in the workspace. Otto sees each file's name, type and size, and up to four images of 5 MB or less. Nothing reaches your chat until Otto shares it.

MCP servers, APIs and CLIs use their own upload methods.

## Every action goes through the trust check

Otto classifies each call from the request it actually sends: the HTTP method and path, the MCP tool name or the CLI subcommand. Reads and changes to your own data run directly. In a conversation, a send to [known recipients](/trust/approvals/#known-recipients) also runs directly. Any other action that reaches other people or deletes data runs directly only when it matches your request. Otherwise Otto asks you first.

:::caution
The trust check doesn't review changes to your own data. For a CLI, it reads the subcommand words, never option values.
:::

## Related resources

- [Apps with Composio](/connect/apps/)
- [Models](/connect/models/)
- [Approvals and the trust check](/trust/approvals/)
- [Vault and saved logins](/trust/vault/)
- [Sandbox and browser](/how-it-works/sandbox-and-browser/)
