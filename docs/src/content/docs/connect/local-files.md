---
title: Local files
description: Let Nod list, read, organize and edit files on your computer in work you start, with secrets and folders you keep it out of always refused.
sidebar:
  order: 5
---

Local files lets Nod work with files on your computer, for example to tidy your Downloads folder, rename invoices by their content or save a report it made next to your other documents. It works in the desktop app on macOS and Windows, and in the Linux Flatpak preview, with nothing to set up. A source install or a self-hosted server doesn't offer it.

## Start with a request

Open chat in the desktop app and tell Nod what to do. You do not need to add a folder in **Apps**.

- "List the files in my Downloads folder."
- "Read invoice.pdf in Downloads and summarize it."
- "Save this report as report.md in Documents."

If Nod asks for confirmation, review the file path and proposed action before you approve it.

## Where Nod can work

Nod can work anywhere in your home folder and on external drives (under `/Volumes` on macOS, a drive other than the system drive on Windows, or `/media/<user>` or `/run/media/<user>` on Linux). It refuses, for every action:

- anything outside your home folder and those drives, and Nod's own data;
- hidden files and folders, such as `.ssh`, `.config` or `.env`;
- `Library` on macOS and `AppData` on Windows, including on external drives, and Time Machine backups;
- files that usually hold secrets: keys and certificates (`.pem`, `.p12`, `.pfx`, `.ppk`, `id_rsa` and similar), password databases and exports (`.kdbx`, `.1pux`, Bitwarden exports), `.env` files, `.ovpn`, `.gpg`, `.asc`, `.tfstate`, `wallet.dat`, files whose name has `credentials` and ends in `.csv`, and `service-account` files ending in `.json`;
- any folder you keep Nod out of.

Nod also never changes your home folder or a drive itself as a whole, for example by moving or trashing it.

On macOS, the first time Nod opens a protected folder, such as Downloads, Documents or Desktop, macOS asks whether Nod may access it. That first visit happens in work you started. If you declined, allow Nod in **System Settings**, **Privacy & Security**, **Files and Folders**.

## Keep Nod out of a folder

Tell Nod, for example "never touch my Taxes folder", in a chat or a task you started. Nod adds it to a list of up to 100 folders it always refuses, without any judgment call: it doesn't list, open or change anything there, and doesn't move or trash a folder that contains it. Only you can take a folder off the list again, in **Settings**, **Privacy & data**, **Kept out of local files**. Nod can't remove one.

## Only work you started

Nod works with your files only in work you started: a message you sent, a task that started from one, or a schedule you set up. Work Nod starts on its own, such as on new email or other activity in a connected app, can't list, open or change files at all. So a message from a stranger can't make Nod read or file your documents.

## What Nod can do

| Action        | What it does                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------- |
| List          | Lists a folder, newest first, up to 500 entries.                                                    |
| Read          | Reads up to 256 KB of a text file.                                                                  |
| Copy to Nod   | Copies a file of up to 90 MB, such as a PDF or a photo, into Nod's workspace so Nod can work on it. |
| Create folder | Creates one folder.                                                                                 |
| Write         | Creates a text file of up to 1 MB, or replaces one.                                                 |
| Edit          | Replaces exact text in a text file of up to 1 MB.                                                   |
| Copy from Nod | Saves a file Nod made in its workspace, such as a report or a converted image, onto your computer.  |
| Move          | Moves or renames up to 200 items at once, and never overwrites.                                     |
| Trash         | Moves up to 200 items to the Trash or Recycle Bin, where you can restore them.                      |

Each action goes through the same [trust check](/trust/approvals/) as an app action, with the real paths after links are followed. Listing a folder is a read and runs without asking. Opening a file, by reading it or copying it to Nod, needs your words: Nod opens a file you named or one in a folder you asked it to work on, and asks first before it opens one that only a file or message mentions. Nod asks before it writes, moves or trashes files your words don't cover.

Nod never deletes a file outright. When it replaces or edits a file, the previous version goes to the Trash from its own place, so **Put Back** returns it there; if the Trash step fails, nothing changes. Nod marks files it writes, edits or copies from its workspace as downloaded when the system allows it, so macOS and Windows check them before they open.

## Limits

- On Windows, `desktop.ini`, `Thumbs.db` and the Recycle Bin count as hidden; Nod doesn't read Windows' hidden attribute. To change an item, Nod needs its full name, not a short name such as `DOCUME~1`.
- The list of secret files is by name. A secret in an ordinary file, such as a password in `notes.txt`, isn't recognized; keep such folders out of Nod.
- Nod doesn't create programs or shortcuts, such as `.exe`, `.bat`, `.lnk` or `.url` files on Windows; `.command`, `.app`, `.pkg`, `.dmg` or `.sh` files on macOS; or `.sh`, `.bash`, `.desktop`, `.run`, `.appimage`, `.jar`, `.flatpak`, `.flatpakref` or `.flatpakrepo` files on Linux, and doesn't rename files into them. It can move an installer that already is one, as long as it keeps its extension. It doesn't change executable files either: on macOS and Linux, files marked executable; on Windows, programs and scripts such as `.exe`, `.bat`, `.ps1` or `.lnk`. Drives formatted as FAT or exFAT, such as many USB sticks, can mark every file as executable on macOS and Linux. Nod can list, read, move and trash files there but cannot write or edit them.
- Links are followed, but the resolved path must still be allowed, so a link can't reach a refused place. A link with a relative target can be renamed but not moved to another folder, because it would point somewhere else there.
- Commands Nod runs in its workspace can't see your files. Files reach the workspace only when Nod copies them there, and only through this check.
- When you [share conversation traces](/trust/conversation-traces/), the text of files Nod reads is part of them, like any other tool result.

## Related resources

- [Connect apps](/connect/apps/)
- [Approvals and the trust check](/trust/approvals/)
- [Your data and privacy](/trust/privacy/)
