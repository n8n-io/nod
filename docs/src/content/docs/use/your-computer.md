---
title: Your computer
description: Let Otto work with the files, Mac apps and screen on your own Mac, what asks you first, and where the limits are.
sidebar:
  order: 9
---

Otto can work on your own Mac: run commands on your files, open Mac apps, read what they show and use them in the background.

It's off by default and works on macOS only. Otto still does most work in its own [workspace](/use/workspace/). It uses your computer when a task is about your files, your Mac apps or your screen.

## What Otto can do

| Action       | What it does                                                                          |
| ------------ | ------------------------------------------------------------------------------------- |
| Run commands | Runs a shell command on your Mac, for example to find, read, move or rename files     |
| See apps     | Lists the Mac apps that are running                                                   |
| Open an app  | Opens a Mac app in the background                                                     |
| Look         | Reads a Mac app's window as a list of its buttons, fields, menus and text             |
| Screenshot   | Takes a picture of one app window, even when another window covers it                 |
| Act          | Presses a button, sets a value, opens a menu or types text and keys into that one app |

Otto acts on Mac apps without moving your mouse or taking keyboard focus, so you can keep working.

## Turn it on

Onboarding asks you to allow **Accessibility** and **Screen Recording**, then turns on **Let Otto use your computer**. You can skip that step.

Later, open **Settings**. Under **Your computer** you can turn it on or off, see both permissions and allow a missing one, and remove a Mac app Otto may use.

## Permissions

Mac app control runs through Otto Computer Use, a helper bundled with the desktop app. macOS lists the permissions under Otto. When you run Otto from source, it lists them under the terminal app that started Otto.

Commands run with an empty environment inside a macOS sandbox profile. The profile blocks:

- Otto's own data folder.
- Keychain services.
- Writes to LaunchAgents, login items and shell startup files.
- Apple Events, and the `open`, `osascript`, `automator` and `shortcuts` commands.

## What asks you first

Every command, every app Otto opens and every action in an app goes through the same [trust check](/trust/approvals/) as app actions. It runs when your words ask for it. Otherwise Otto asks you.

When your request names the Mac app, Otto uses it and remembers it. Otherwise it asks once, for example "May I use Notes on your computer?". That yes covers the step and the app, and is remembered. Allowed apps are listed in **Settings**, where you can remove one. Listing running apps, looking at an allowed app and taking its screenshot don't ask.

Otto never uses these, even if you ask:

- Terminal apps: Terminal, iTerm, Warp, Ghostty, kitty and Alacritty.
- Script Editor, Automator and Shortcuts.
- Otto itself.
- macOS security prompts and the login window.

What Otto reads or sees on your Mac goes to your selected model. Otto treats it as data, never as instructions.

## Stop Otto

Otto uses one Mac app step at a time, across all tasks. While it does, the menu bar shows **Using** and the apps' names, with **Stop**.

**Stop** ends the task at once. An action already sent to an app can't be taken back. Otto marks it uncertain and never runs it again.

## Limits

:::caution[What this doesn't cover]

- Electron apps, such as Slack or VS Code, often show only a few controls. Otto takes a screenshot when it can't read enough.
- The sandbox profile is a deny list, not an allow list. It blocks the known escapes (Otto's keys and data, the Keychain, Docker and VM sockets, other processes' arguments, Launch Services, launchd and cron), but a deny list can still miss a new route.
- The source install can run commands only. Mac app control needs the desktop app.
- A command you approve runs as you. It can change or delete any file the profile doesn't block.

:::

## Related resources

- [Chat with Otto](/use/chat/)
- [Workspace and files](/use/workspace/)
- [Approvals and the trust check](/trust/approvals/)
- [Sandbox and browser isolation](/how-it-works/sandbox-and-browser/#your-computer)
