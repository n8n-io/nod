---
title: MCP servers, APIs and CLIs
description: Connect Notion and Linear through their MCP servers, and let Otto set up other services through an MCP server, an HTTP API or a command-line tool.
sidebar:
  order: 3
---

Besides [Composio apps](/connect/apps/), Otto connects to Notion and Linear through their own MCP servers. For other services, it can set up an MCP server, an HTTP API or a command-line tool (CLI).

## Notion and Linear

Notion and Linear connect through their own hosted MCP servers, the same way as any [other MCP server](#connect-another-service). You sign in with OAuth, and you don't need a Composio key. Open **Apps** and select **Connect**.

Otto can use every tool these servers offer, so it can read and change pages, issues and projects. Each change goes through the same [trust check](/trust/approvals/) as any app action. If Otto can't refresh a sign-in because it expired or was revoked, **Apps** shows **Sign-in required** with **Reconnect** from then on. Connect a Notion or Linear account again if you connected it with an earlier version of Otto.

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
  sealed --> runner[Runs as<br/>its own user]:::go
  token[(Token in Vault)]:::accent -- one variable --> runner
  files[Workspace files]:::muted -. as arguments .-> runner
  runner -- text output --> otto[Otto]
```

Otto installs each tool as its own Linux user, in a folder only that user can open, so neither the workspace user nor another connected tool can change it or read its token. Each run gets an environment built from scratch: a `PATH` with the sealed tool and system folders, a private temporary home and the one token variable.

Nothing comes from the workspace user's files or settings. A program that the model writes or replaces in the workspace never receives the token. You can still pass workspace files as arguments, and the CLI returns text.

## Send and receive files

To attach a workspace file to a Composio action, Otto passes `{workspaceFile, mimeType, name?}`. The server reads and checks the files, then uploads them. Files in one action can total 15 MB. If the action waits for your approval, the attachment can't change in the meantime.

Files that apps send back are saved privately in the workspace. Otto sees each file's name, type and size, and up to four images of 5 MB or less. Nothing reaches your chat until Otto shares it.

MCP servers, APIs and CLIs use their own upload methods.

## Every action goes through the trust check

The [checker](/trust/approvals/) sees each call's arguments as Otto sends them: the method, path and body, the MCP tool and input, or the CLI arguments. For a saved API or MCP server it sees the path or tool, not the server's address. It runs reads and drafts, and anything else only when your words ask for it. Otherwise Otto asks you first.

## Related resources

- [Apps with Composio](/connect/apps/)
- [Models](/connect/models/)
- [Approvals and the trust check](/trust/approvals/)
- [Vault and saved logins](/trust/vault/)
- [Sandbox and browser](/how-it-works/sandbox-and-browser/)
