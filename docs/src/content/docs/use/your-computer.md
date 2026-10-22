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
| See apps     | Lists the Mac apps that are running                                                   |
| Open an app  | Opens a Mac app in the background                                                     |
| Look         | Reads a Mac app's window as a list of its buttons, fields, menus and text             |
| Screenshot   | Takes a picture of one app window, even when another window covers it                 |
| Act          | Presses a button, sets a value, opens a menu or types text and keys into that one app |

nod sends actions to the selected app without moving your mouse. Some actions, such as raising a window, can bring it forward.

When you ask for a screenshot, nod can attach the app window image to your conversation. Screenshots it takes only to inspect an app stay in the model's context.

## Turn it on

Onboarding asks you to allow **Accessibility** and **Screen Recording**. After granting both, return to nod and select **Continue** to turn on **Let nod use your computer**. You can select **Not now** to skip the step.

If permissions can't be checked, select **Try again** or **Not now**. nod keeps the feature off until you turn it on.

A source install without the computer helper offers files and commands only. Select **Continue** to enable those; no Accessibility or Screen Recording grants are needed.

Later, open **Settings**. Under **Your computer** you can turn it on or off, see both permissions and allow a missing one, and remove a Mac app nod may use.

## Permissions

Mac app control runs through nod Computer Use, a helper bundled with the desktop app. Allow the app named in the macOS permission prompt under **System Settings → Privacy & Security**. Return to nod after changing a permission so it can check again.

If macOS asks you to quit, reopen nod from Applications. Your setup progress is saved.

Commands run with a clean environment inside a macOS sandbox profile. The profile blocks:

- nod's data and install folders.
- Your `Library` folder and hidden files and folders directly in your home folder, including browser profiles and command-line credentials.
- Keychain services.
- Writes to LaunchAgents, login items and shell startup files.
- Apple Events, and the `open`, `osascript`, `automator` and `shortcuts` commands.

## What asks you first

Every command, every app nod opens and every action in an app goes through the same [trust check](/trust/approvals/) as app actions. It runs when your words ask for it. Otherwise nod asks you.

When your request names the Mac app, nod uses it and remembers it. Otherwise it asks once, for example "May I use Notes on your computer?". That yes covers the step and the app, and is remembered. Allowed apps are listed in **Settings**, where you can remove one. Listing running apps, looking at an allowed app and taking its screenshot don't ask.

nod never uses these, even if you ask:

- Terminal apps: Terminal, iTerm, Warp, Ghostty, kitty and Alacritty.
- Script Editor, Automator and Shortcuts.
- Passwords, Keychain Access and System Settings.
- nod itself.
- macOS security prompts and the login window.

What nod reads or sees on your Mac goes to your selected model. nod marks these results as untrusted data.

## Stop nod

nod uses one Mac app step at a time, across all tasks. While it does, the menu bar shows **Using** and the apps' names, with **Stop**.

**Stop** ends the task at once. An action already sent to an app can't be taken back. nod marks it uncertain and never runs it again.

Turning off **Let nod use your computer** stops computer work in progress. Removing an allowed app stops work in that app and prevents pending confirmations from using its old access. An action already sent may still have completed.

## Limits

:::caution[What this doesn't cover]

- Electron apps, such as Slack or VS Code, often show only a few controls. nod takes a screenshot when it can't read enough.
- The sandbox profile is a deny list, not an allow list. It blocks the known escapes (nod's keys and data, the Keychain, Docker and VM sockets, other processes' arguments, Launch Services, launchd and cron), but a deny list can still miss a new route.
- A source install can run commands. To use Mac apps too, build the helper with `pnpm run computer:build` before starting nod.
- A command you approve runs as you. It can change or delete any file the profile doesn't block.
- The shell can't access `~/.Trash`. nod asks you to move unwanted files to Trash yourself.
- Native app screenshots aren't masked. Content visible in the selected app can reach your model, including sensitive information.

:::

## Related resources

- [Chat with nod](/use/chat/)
- [Workspace and files](/use/workspace/)
- [Approvals and the trust check](/trust/approvals/)
- [Sandbox and browser isolation](/how-it-works/sandbox-and-browser/#your-computer)
