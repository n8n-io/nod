---
title: Your computer
description: Let nod work with the files, Mac apps and screen on your own Mac, what asks you first, and where the limits are.
sidebar:
  order: 9
---

nod can work on your own Mac: run commands on your files, open Mac apps, read what they show and use them in the background.

It's off by default and works on macOS only. nod still does most work in its own [workspace](/use/workspace/). It uses your computer when a task is about your files, your Mac apps or your screen.

## What nod can do

| Action       | What it does                                                                          |
| ------------ | ------------------------------------------------------------------------------------- |
| Run commands | Runs a shell command on your Mac, for example to find, read, move or rename files     |
| Share a file | Attaches an original Mac file to your conversation without rewriting its contents     |
| See apps     | Lists the Mac apps that are running                                                   |
| Open an app  | Opens a Mac app in the background and reads its current window                        |
| Look         | Reads a Mac app's window as a list of its buttons, fields, menus and text             |
| Screenshot   | Takes a picture of one app window, even when another window covers it                 |
| Act          | Presses a button, sets a value, opens a menu or types text and keys into that one app |

When you name one app, nod opens it directly and reads a fresh view, including when it is already running. You don't need a separate step to list running apps.

nod sends actions to the selected app without moving your mouse. After opening or acting in an app, nod tries to read a fresh view to check the result. If that view is unavailable, it looks again before acting and never repeats the completed action. Some actions, such as raising a window, can bring it forward.

When you ask for a screenshot, nod can attach the app window image to your conversation. Sharing always goes through the trust check, even for an allowed app. For app inspection, each new request or continuation starts without older views. nod keeps only that request's two latest views in the model's context; earlier views remain in the saved conversation.

## Turn it on

In onboarding, use the switch beside **Accessibility** or **Screen Recording** to open its macOS permission settings. Each switch turns on after macOS confirms the permission. After granting both, return to nod and select **Continue** to turn on **Let nod use your computer**. You can select **Not now** to skip the step.

Each granted permission shows **Allowed**. A failed check shows **Not checked**, so it is distinct from a denied permission. Select **Try again** to check again, or **Not now** to skip onboarding. You can still turn computer access off in Settings when a permission check fails.

A source install without the computer helper offers files and commands only. Select **Continue** to enable those; no Accessibility or Screen Recording grants are needed.

Later, open **Settings**. Under **Your computer** you can turn it on or off, see both permissions and allow a missing one, and remove a Mac app nod may use.

## Permissions

Mac app control runs through nod Computer Use, a helper bundled with the desktop app. Allow the app named in the macOS permission prompt under **System Settings → Privacy & Security**. Return to nod after changing a permission so it can check again.

If you previously denied Screen Recording, use its switch again. nod opens the Screen Recording page in System Settings so you can enable it there.

If macOS asks you to quit, nod shows **Closing nod** while it stops its private computer. Wait for it to close, then reopen the same app from Applications if macOS hasn't reopened it. Your setup progress is saved.

Commands run with a restricted environment inside a macOS sandbox profile. The profile blocks:

- nod's data and install folders.
- Your `Library` folder and hidden files and folders directly in your home folder, including browser profiles and command-line credentials.
- Keychain services.
- Writes to LaunchAgents, login items and shell startup files.
- Apple Events, and the `open`, `osascript`, `automator` and `shortcuts` commands.

## What asks you first

Every file share, command, app launch and action in an app goes through the same [trust check](/trust/approvals/) as app actions. It runs when your words ask for it. Otherwise nod asks you.

When your request names the Mac app, nod uses it and remembers it. Otherwise it asks once, for example "May I use Notes on your computer?". That yes covers the step and the app, and is remembered. Allowed apps are listed in **Settings**, where you can remove one. Listing running apps doesn't ask. Looking at an allowed app, taking its screenshot or opening it while it is already running only reads its current view. Your rules still apply to these reads; a rule to ask first pauses them for confirmation.

Native app control blocks these known apps by bundle ID or name, even if you ask:

- Terminal apps: Terminal, iTerm, Warp, Ghostty, kitty and Alacritty.
- Script Editor, Automator and Shortcuts.
- Passwords, Keychain Access and System Settings.
- nod itself.
- macOS security prompts and the login window.

Unlisted terminal and scripting apps may not be blocked.

What nod reads or sees on your Mac goes to your selected model. nod marks these results as untrusted data. Sharing a file transfers its original bytes directly; the model receives attachment metadata instead of the file contents. File sharing uses the same sandbox restrictions as commands and accepts regular files up to 90 MB. Symbolic links, files with multiple hard links, and empty files are refused.

## Stop nod

nod uses one Mac app step at a time, across all tasks. While it does, the menu bar shows **Using** and the apps' names, with **Stop**.

The menu-bar **Stop** ends tasks using your computer and leaves unrelated tasks running. An action already sent to an app can't be taken back. nod marks it uncertain and never runs it again.

If a command times out, nod stops it and keeps its partial output. Completion remains unknown; nod checks the current state instead of repeating the command.

Turning off **Let nod use your computer** stops computer work in progress. Removing an allowed app stops work in that app and prevents pending confirmations from using its old access. An action already sent may still have completed.

## Limits

:::caution[What this doesn't cover]

- Electron apps, such as Slack or VS Code, often show only a few controls. nod takes a screenshot when it can't read enough.
- The sandbox profile is a deny list, not an allow list. It blocks the known escapes (nod's keys and data, the Keychain, Docker and VM sockets, other processes' arguments, Launch Services, launchd and cron), but a deny list can still miss a new route.
- A source install can run commands. To use Mac apps too, build the helper with `pnpm run computer:build` before starting nod.
- A command you approve runs as you. It can change or delete any file the profile doesn't block.
- Commands must finish within the tool call. Background services and some programs that launch other commands are unsupported. Remaining child processes stop when the command ends.
- The shell can't access `~/.Trash`. nod asks you to move unwanted files to Trash yourself.
- Native app screenshots aren't masked. Content visible in the selected app can reach your model, including sensitive information.

:::

## Related resources

- [Chat with nod](/use/chat/)
- [Workspace and files](/use/workspace/)
- [Approvals and the trust check](/trust/approvals/)
- [Sandbox and browser isolation](/how-it-works/sandbox-and-browser/#your-computer)
