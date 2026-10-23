# Native UX changes

This branch implements the interaction changes from the [assessment](ux-delighters-2026-10-23.md). It keeps the existing layout, colors, and type.

The branch is `feat/native-ux-delighters`. Its base is `8ab87eff` on `main`. The assessment describes an earlier source version. Task receipts, browser handoff recovery, account recovery, and Stop all work changed on `main` after that assessment. This branch keeps those changes.

## Scope

| ID  | Result                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D01 | Save the draft on this device for the account and thread. Restore text, reply, and checked uploaded files. Request the original file again after an interrupted upload.  |
| D02 | Drag an owned artifact from a card, image, or preview file icon through Electron's native file drag API. Prepare real bytes in a private temporary folder.               |
| D03 | Copy a raster image as PNG clipboard data at its original resolution. Keep alpha. Show a failure when the clipboard is unavailable.                                      |
| D04 | Copy safe rendered HTML and plain text. Copy tables as tab-separated cells. Keep Copy Markdown as a separate action.                                                     |
| D05 | Accept file drops across chat. Add them to the draft once. Keep private entry and browser handoff separate.                                                              |
| D06 | Add an existing artifact to the current draft with Use in message.                                                                                                       |
| D07 | Reply to a selected passage. Store the quote separately from the owner's message. Keep its source message ID.                                                            |
| D08 | Show Copy success or failure beside the control.                                                                                                                         |
| D09 | Save to Downloads without replacing a file. Show Open and Show in folder after the copy completes.                                                                       |
| D10 | Keep mounted preview state for the last eight files, within a 90 MB retention limit. Keep page, zoom, scroll, and sheet state during file switches.                      |
| D11 | Edit task and schedule titles in place. Use explicit Save and Cancel. Add Command/Ctrl+Enter to save a memory edit.                                                      |
| D12 | Undo removal of an uploaded draft file. Keep schedule Undo available during hover, focus, or app switching. Use revision checks to reject stale schedule Undo.           |
| D13 | Reject oversized files individually. Keep valid files from the same batch.                                                                                               |
| D14 | Distinguish sending from server-queued messages. Keep the current message ID and existing send recovery.                                                                 |
| D15 | Copy a code block or table without adjacent prose or controls.                                                                                                           |
| D16 | Choose Enter to send or Enter for a new line. Keep Command/Ctrl+Enter and input-method composition support.                                                              |
| D17 | Add system file menus in desktop and explicit file controls in web. Keep preview and download available without dragging.                                                |
| D18 | Keep selected-text right-click separate from the message menu. Add native text edit menus in desktop.                                                                    |
| D19 | Preview the next schedule run through the same server timing rules used for execution. Do not save the preview.                                                          |
| D20 | Keep failed inline edits and file-copy edits open with their text and error. Keep existing memory failure recovery.                                                      |
| D21 | Rename task display metadata without changing its goal. Rename schedule titles without changing their instructions.                                                      |
| D22 | Open a reply source outside loaded history. Keep a Return control and restore the prior visible message position.                                                        |
| D23 | Let inner edit and export controls handle Escape before the preview. Keep existing dialog and menu handling.                                                             |
| D24 | Label the main control Stop all work. Keep the latest server stop behavior and task-specific controls from main.                                                         |
| D25 | Restore focus after inline title edits. Keep preview, Settings, private entry, and composer focus recovery.                                                              |
| D26 | Choose a file directly from the native filename selector. Keep previous and next controls.                                                                               |
| D27 | Keep task row order steady while the pointer or keyboard focus is inside the list. Apply the new order after interaction ends.                                           |
| D28 | Open an owned file through its save receipt. Keep existing task cost receipts and actual result links from main. Do not create provider URLs.                            |
| D29 | Keep existing connection return notices and task routing. Durable drafts also preserve text and file references through reload.                                          |
| D30 | Show the server state on the original action confirmation: pending, approved and queued, working, done, declined, expired, or outcome unclear. Add no execution control. |
| D31 | Keep the explicit handoff state and single-resume rules from main. Closing a preview does not complete a handoff.                                                        |
| D32 | Keep reconnect state recovery and message identity from main. Restore device drafts after reload. Do not retry turns or outside actions.                                 |

The four larger ideas also have a bounded implementation:

- Search the current stored conversation, with up to 50 recent matches, source navigation, and Return.
- Open a command menu for pages, files, tasks, and actions on the selected file. Editing fields keep their own keys.
- Edit a plain-text or Markdown file of 4 MB or less. Save a new copy to the draft. Keep the original file and transcript.
- Select files and download one ZIP, up to 90 MB in total. Use distinct archive names. A failed file prevents a partial export.

## Data and execution boundaries

The desktop bridge takes an artifact ID and a fixed action. It takes no host path or destination URL. The main process checks the engine frame and owner access. The private temporary cache holds up to eight files. Active file actions protect their copy from eviction for five minutes. Saving creates a separate Downloads copy. Temporary copies remain until cache eviction or app shutdown. Shutdown cancels unfinished preparation before cleanup. A forced stop can leave temporary copies behind. Native Open accepts a fixed set of document and raster image types.

Selected reply text is message data. It does not replace the owner's words or the original replied message in the trust check. Confirmation status comes from owner-scoped approval rows. It does not add a way to run an action.

Drafts use local storage for the current device, account, and thread. Private entry fields are separate. Known verification replies and security codes are excluded. There is no new analytics event or model request.

## Desktop review

On macOS, run the synthetic fixture after a web build. Recording requires `ffmpeg` on the path.

```sh
pnpm run build
env -u ELECTRON_RUN_AS_NODE desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/ux-delighters-demo.mjs
```

The fixture uses a temporary Electron profile, a private Downloads folder, and in-memory HTTP data. It does not use the normal database, model, or app accounts. It uses the production preload and native file handler. The fixture prints its loopback address.

Request `/__fixture/record` at that address to start a recording. Use the desktop UI, then request `/__fixture/finish` to close the fixture and finish `.local/ux-delighters/desktop.mp4`. The recording captures the Electron page. System menus and Finder are outside that capture.

## Validation

The later UX pass checked keyboard entry, focus recovery, narrow file panels, failed sends, failed title saves, and nested Escape behavior. It corrected the Undo notice, stale search results, reused file identity, and draft preview recovery. The code review also corrected draft parsing, schedule preview dates, image sizing, temporary file bounds, and portable filenames. Native downloads now stream to disk and remove partial files after cancellation. Restored files wait for a metadata check; a failed check keeps the reference for Retry. Long drafts and saved file lists restore without truncation. Search excerpts follow full-text matches, and ZIP names remain distinct on common case-insensitive file systems. Existing integration tests cover the added storage and file contracts.

- **Source checks:** `pnpm run check` passed. Types, architecture boundaries, and formatting passed.
- **Integration fixtures:** `pnpm run test:integration` passed all 624 tests, with no skips. The run used disposable PostgreSQL state, Chromium, and local provider fixtures.
- **Desktop fixtures:** `pnpm run desktop:test` passed 188 tests. Two platform tests were skipped. File export checks cover exact bytes, safe names, duplicate saves, missing files, and restricted native opening.
- **Builds:** The app build and the docs build passed. All published internal docs links are valid. Vite reports the existing large-chunk warning.
- **macOS UI checks:** Checked table and code Copy feedback, image copy and paste, selected-text replies, draft reload, attachment Undo, preview switching at 125% zoom, file reuse, native menus, save receipts, separate edited copies, search, Return, Commands, and ZIP export. The ZIP contains the two selected files. A native PDF drag back into chat supplies real file bytes.
- **Video:** [Desktop demo](../review/ux-delighters/desktop.mp4) is a 64-second recording of the actual Electron page with synthetic data. Its frames were inspected. It shows the main chat and file flows. System menus and Finder are outside the page capture.
- **Device limits:** A completed Finder or Explorer drop still needs a separate check. Native drag, clipboard target formats, and system menus also need checks on Windows and Linux. This review does not establish results on those systems or on touch devices.
- **Live checks:** None. No live model, connected account, recipient, or normal local database was used.
