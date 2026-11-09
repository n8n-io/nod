---
title: Sandbox and browser isolation
description: How Nod's workspace and browser containers are locked down, what each part can reach, and where the limits are.
sidebar:
  order: 4
---

This page explains how Nod isolates the commands it runs and the websites it visits, and what each part of the system can and can't reach.

The short version: commands run as an unprivileged user in a workspace container. The browser runs in a separate container. Provider keys and the owner access key stay in the server process.

## Trust boundaries

```mermaid
flowchart LR
  server[Nod server<br/>provider keys · Vault]:::accent
  subgraph workspace[Workspace container]
    sandbox[Sandbox user<br/>runs Pi commands]
    cli[One user per CLI<br/>one CLI token each]
  end
  browser[Browser container<br/>Chromium · profiles]:::muted
  net([Internet])
  server -- supervised commands --> sandbox
  server -- sealed CLI run --> cli
  server -- stdin bridge --> browser
  sandbox --> net
  cli --> net
  browser --> net
```

## What each part can and can't reach

|                       | Server                           | Sandbox user              | Connected CLI user        | Browser container                               |
| --------------------- | -------------------------------- | ------------------------- | ------------------------- | ----------------------------------------------- |
| Provider keys         | Yes                              | No                        | No                        | No                                              |
| Owner access key      | Yes                              | No                        | No                        | No                                              |
| Vault values          | Yes                              | No                        | No                        | Only a value the server enters in a page        |
| A connected CLI token | Yes                              | No                        | Its own token only        | No                                              |
| Docker control        | Local socket or restricted proxy | No                        | No                        | No                                              |
| Workspace files       | Through a guarded reader         | Yes                       | Files passed as arguments | No shared mounts                                |
| Browser profiles      | Through the bridge               | No                        | No                        | Yes                                             |
| Internet              | Yes                              | Yes, see the limits below | Yes, with the same limits | Public addresses only, saved profiles included. |

## The workspace container

Pi's native tools (`read`, `bash`, `edit`, `write`, `find` and `ls`) run inside the workspace through `WorkspaceSession.exec`. Each thread works in `/workspace/<thread ID>`. A source install mounts `NOD_DATA_ROOT/workspaces`; self-hosted and desktop runtimes use a persistent workspace volume. `/home/node` is a separate volume, so tools Pi installs persist.

- Commands run as the unprivileged `node` user, without sudo.
- Bash gets no host environment. It sets the owner's `TZ` when known.
- No workspace file is loaded as instructions.

Both the workspace and browser containers drop all capabilities, set `no-new-privileges` and have these limits:

| Container | Source install (`compose.yaml`)                      | Local desktop runtime                              | Self-hosted server defaults                                |
| --------- | ---------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Workspace | 8 GB memory, 4 CPUs, 4,096 processes                 | 2 GB memory, 2 CPUs, 1,024 processes               | 2 GB memory, no CPU limit, 512 processes                   |
| Browser   | 8 GB memory, 6 CPUs, 4,096 processes, read-only root | 2 GB memory, 2 CPUs, 768 processes, read-only root | 3 GB memory, no CPU limit, 1,024 processes, read-only root |

The self-hosted server reaches Docker through a restricted proxy for its workspace and browser containers. Its Compose configuration allows separate memory limits through `NOD_WORKSPACE_MEMORY` and `NOD_BROWSER_MEMORY`.

## The command supervisor

Every command goes through a small supervisor inside the container, in [`src/providers/docker/command.ts`](https://github.com/n8n-io/nod/blob/main/src/providers/docker/command.ts).

- It owns the command's session and signals every process in it, even ones that left the process group.
- A command also ends the processes it detached, when the command itself ends, so work it left behind never outlives it. Stop ends the whole tree the same way, and escalates to `SIGKILL` for a process that ignores the first signal.
- It enforces the timeout: 59 minutes for `bash` by default. The model can ask for longer.
- It acknowledges when the command ends. If that acknowledgement is lost, the server fences the workspace: no more commands run until Nod restarts.

## Command output

Up to 1 MiB of output reaches Pi. Pi shows the model the tail, and codemode scripts get the whole output and the exit code. Larger output keeps its first and last 512 KiB and names the complete log in the workspace.

Pi writes truncated output, codemode files and images, and extracted web PDFs to the server's temp folder. The runtime moves each file into the workspace's `.nod/outputs` folder and rewrites its path before the result is recorded. See [`src/providers/pi/sandbox.ts`](https://github.com/n8n-io/nod/blob/main/src/providers/pi/sandbox.ts).

## Connected CLIs

Each connected CLI runs as its own Linux user, derived from its path ID, in group `nod-connected`. Before each run, the supervisor installs the CLI's declared source into `/var/tmp/nod-cli-<path id>`, a folder only that user can open, if it's missing. It refuses an install folder or executable that another user can write, and refuses to run if another CLI's install belongs to the same user. So one CLI can't change another's install or read its token.

The CLI then runs with an environment built from scratch: a fixed `PATH`, a private temporary `HOME` and `XDG_CONFIG_HOME`, `LANG` and the connection's credential variables. Nothing comes from the sandbox user's files or environment, so a program the model plants never receives the token. See [MCP, APIs and CLIs](/connect/mcp-api-cli/).

## The browser container

The browser is a separate trusted container. It doesn't share mounts or a network namespace with the workspace. The server drives Vercel Labs [agent-browser](https://github.com/vercel-labs/agent-browser) over a fixed stdin bridge to a private Unix socket.

| Setting    | Value                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| Display    | Headed Chromium on a private 1920x1080 virtual display per session      |
| Viewport   | 1440x900, with Noto fonts and software WebGL                            |
| Time zone  | The owner's saved IANA time zone, or UTC when unknown or invalid        |
| Language   | The owner's formatting locale, such as en-GB, sent as `Accept-Language` |
| HTTP cache | Under `/tmp`, per session, outside saved profiles                       |

Pi reads the page from agent-browser's accessibility snapshot, with `@eN` references, as plain text after the page URL. A snapshot returns up to 40,000 characters, and Pi reads the rest with an offset. Pi interprets the page and chooses controls. The server also reads the selected control's form method and destination for the trust check, and the page's visible text when it prepares a confirmation question.

Every browser command has a deadline: 60 seconds, or a wait's own timeout plus 30 seconds. That leaves room for agent-browser's own 30-second limit on each browser call, so only a browser that has stopped answering misses it. A browser that misses its deadline, is interrupted or doesn't close within 5 seconds is killed with all its Chromium processes. A cancelled action requires an explicit open or saved-session selection before that browser can continue. Once cancellation is acknowledged, other sessions keep their browsers and can continue. A lost bridge response still requires recovery of the application namespace because the worker may have closed it. Nod never repeats the interrupted action during recovery. While a dialog is open, the observation is the dialog, and every action except open is refused until Pi accepts or dismisses it.

Known secret values (passwords, codes, card numbers and security codes) are removed from tool output and masked in screenshots; usernames and the cardholder name aren't secrets and stay visible. URL parameters that carry credentials, such as tokens and signatures, are hidden; other query parameters stay. When an action fails, Pi sees the browser's own error with known secrets removed. Pi uses saved profiles through `browser_session` and never reads their files. The code is in [`src/providers/agent-browser/`](https://github.com/n8n-io/nod/tree/main/src/providers/agent-browser).

## Browser handoff

When Pi needs you in the browser, it calls `browser` with `action: handoff` and a clear instruction. Nod web shows the live tab in chat.

```mermaid
sequenceDiagram
  participant Pi
  actor You
  participant Server
  participant Browser
  Pi->>You: Instruction and live browser view
  Browser-->>You: Live JPEG frames
  You->>Server: Clicks, typing and scrolling
  Server->>Browser: Forwarded while the chat turn waits
  You->>Server: Return to Nod
  Note over Pi: Next turn takes a fresh snapshot
```

- Each handoff identifies its waiting turn and browser. Input reaches only that browser while its question stays pending. Other sessions keep their own browsers.
- **Return to Nod** continues the session that asked, including a background session, without posting a message for you. Pi looks at the page to see what you did.
- The panel scrolls into view once, when its first frame arrives. While it is open, the task ledger marks its task `browserHandoff`. With the full prompt, not the compact one for small context windows, the coordinator then points you to the panel instead of forwarding a message, because a task reply closes the handoff.
- One bridge call carries frames out, newest first, and your input in. Each input is acknowledged after the browser applies it. Failures reach the view without retrying the input. Losing the connection rejects pending input and disables it until the view reconnects.
- Frames pause during credential entry. Passwords you type in the handoff join the known secrets.
- An init script makes every passkey request fail at once and reports no passkey support, so a sign-in doesn't open a passkey prompt that the live view can't show.

:::caution[Limits]
In a source install or self-hosted server, the workspace has internet access through normal Docker routing. There is no egress firewall, so a command can reach any address the host network can. The desktop app's local runtime blocks workspace traffic to private and reserved address ranges. Connecting a desktop client to a server does not add that firewall to the server. The browser reaches only public addresses. Inside the browser container, Chromium runs with its own sandbox turned off; the container is the boundary.
:::

## Related resources

- [Architecture](/how-it-works/architecture/)
- [The agent runtime](/how-it-works/agent-runtime/)
- [Nod's workspace](/use/workspace/)
- [The browser](/use/browser/)
- [Security model and limits](/trust/security-model/)
