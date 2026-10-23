# UX delighters for nod

Prioritize file transfer, draft recovery, useful copy actions, and editing at the point of use. These changes can make nod feel more complete with its current interface.

The strongest product promise is: **Your work moves where you expect, and you can continue where you stopped.**

This assessment contains 32 small interaction recommendations and four larger ideas to consider later. The order is a design judgment, not a measured result.

## Native behavior first

The implementation is tracked in [Native UX changes](ux-delighters-implementation.md). This assessment records the earlier source review and its proposed checks.

The user's preference is to make these interactions as native and clean as possible. Use that preference to select the implementation.

- Use real operating-system file drags, completed file references, and clipboard data.
- Keep system file pickers, ordinary text selection, spellcheck, and standard editing commands.
- Use native desktop menus for file actions where practical. Keep browser text and link menus available.
- Follow the host platform's shortcuts and pointer behavior. Make equivalent actions clear on touch screens.
- Keep an inline edit in the same position. Use a normal input with familiar Save and Cancel keys.
- Add a visible control only when it helps the current action. Put feedback beside that control and keep it brief.

nod already has a native desktop Edit menu in [the desktop shell](../../desktop/main/main.mjs). Extend that foundation.

## Scope and evidence

Assessed on 23 October 2026, against local commit `f24f29b8`.

The review covered the chat, composer, message actions, file viewer, tasks, schedules, memory, app connections, private entry, and desktop file handling. It used source code, product documentation, and three existing screenshots with synthetic data: chat, task previews, and Trust.

This was a source and design review. It did not include a running-app interaction test, a native desktop drag test, or a user study. An existing handler proves that code is present. It does not prove that the interaction works on every device. An absent dedicated handler does not prove that browser defaults cannot supply part of the behavior.

Research supports the principles below. Product documentation supplies reference behaviors. The proposed changes and their order are my recommendations for nod.

### What the research supports

| Evidence                                                                                          | Useful finding                                                                                                               | Application to nod                                                               |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [NN/g: Microinteractions](https://www.nngroup.com/articles/microinteractions/)                    | A small interaction pairs a trigger with a clear, local response. Feedback and error prevention are central uses.            | Put copy feedback beside Copy. Keep an upload error beside its file.             |
| [NN/g: Response time limits](https://www.nngroup.com/articles/response-times-3-important-limits/) | About 0.1 seconds feels immediate. Longer delays can interrupt thought and attention. These are general guidelines.          | Acknowledge input at once. Show the actual result when the server confirms it.   |
| [NN/g: Animation and motion](https://www.nngroup.com/articles/animation-purpose-ux/)              | Motion can explain feedback and state changes. Unnecessary motion competes for attention.                                    | Use short state transitions. Keep the next action available during them.         |
| [Microsoft Research: Human-AI interaction](https://www.microsoft.com/en-us/research/?p=564561)    | The guidelines include efficient correction, dismissal, relevant context, and clear consequences.                            | Make a draft easy to correct. Keep Stop clear. Show which task receives a reply. |
| [W3C: Dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)    | A drag interaction generally needs an equivalent pointer action without dragging. Keyboard access is a separate requirement. | Keep Attach, Download, and Use again beside drag shortcuts.                      |
| [W3C: Modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)               | Dialogs need predictable focus, Escape handling, and a useful focus destination when they close.                             | Treat focus recovery as part of completing an interaction.                       |

These sources do not establish a conversion, retention, or satisfaction gain for nod. That needs observation of people who use nod.

### What to learn from polished products

| Reference                                                                                                                          | Documented behavior                                                                      | Principle to take                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Linear editor](https://linear.app/docs/editor)                                                                                    | Markdown input, selection tools, keyboard commands, and an escape from automatic embeds. | Offer several familiar ways to do the same action. Let the user reject a conversion. |
| [Linear comments](https://linear.app/docs/comment-on-issues)                                                                       | Comments accept file drops and keep unsent drafts.                                       | Preserve unfinished work and accept input where the user is working.                 |
| [Linear selection](https://linear.app/docs/select-issues)                                                                          | The selected object works with shortcuts, menus, and pointer actions.                    | Selection should define the target consistently.                                     |
| [Linear deletion](https://linear.app/docs/delete-archive-issues)                                                                   | Deletion has immediate Undo and a later recovery path.                                   | Make a recoverable mistake easy to correct.                                          |
| [Apple Quick Look](https://support.apple.com/en-gb/guide/mac-help/mchlgtd_prev01/27/mac/27)                                        | A file preview opens quickly, supports file navigation, and closes with familiar keys.   | A preview is a short visit. Preserve the place the user came from.                   |
| [Slack Enter preference](https://slack.com/help/articles/115005523006-Set-your-Enter-key-preference-Set-your-Enter-key-preference) | The user can choose whether Enter sends or starts a new line.                            | Respect the user's writing habit.                                                    |

My inference from these references: consistency across the whole interaction matters more than an isolated surprise. A file should remain useful after its preview opens.

## What nod already does

Keep these behaviors. They are part of the product's existing quality.

| Existing behavior                                                                             | Source evidence                                                                                                                                            | Remaining opportunity                                                                              |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| File picker, file drop on the composer, image paste, local preview, upload retry, and removal | [Composer](../../src/web/components/composer.tsx), [paste handling](../../src/web/lib/composer-editor.ts)                                                  | Extend the drop target. Improve mixed valid and invalid batches.                                   |
| Text and attachments return after a failed message send                                       | [Composer](../../src/web/components/composer.tsx), [chat](../../src/web/pages/chat.tsx)                                                                    | Add durable recovery after reload or restart.                                                      |
| Chat remains mounted when another main page opens                                             | [App](../../src/web/app.tsx)                                                                                                                               | Navigation within the app already preserves the current chat state. Do not report this as missing. |
| File panel, arrow navigation, resize, image zoom, and several document previews               | [File panel](../../src/web/components/artifact-drawer.tsx), [preview content](../../src/web/components/attachment-data.tsx)                                | Remember each file's reading state. Improve reuse and export.                                      |
| The file panel remembers its width and restores attachment focus                              | [File panel](../../src/web/components/artifact-drawer.tsx), [attachment focus](../../src/web/components/attachment-images.tsx)                             | Extend this care to file position, zoom, and related flows.                                        |
| Whole-message Copy and Reply, right-click actions, and reactions                              | [Messages](../../src/web/components/message.tsx)                                                                                                           | Add selected-text replies, useful copy formats, and visible success feedback.                      |
| Scroll tracking, history position recovery, unread counts, and Back to latest                 | [Chat](../../src/web/pages/chat.tsx), [message rail](../../src/web/components/chat-turn-rail.tsx)                                                          | Check late preview loads and preserve text selection during updates.                               |
| Direct schedule timing changes, pause, and an Undo notice                                     | [Schedule controls](../../src/web/components/plan-controls.tsx)                                                                                            | Improve field entry, next-run feedback, and Undo availability.                                     |
| Memory editing with Save, Cancel, and dirty-state reporting                                   | [Memory](../../src/web/pages/memory.tsx)                                                                                                                   | Make entry and keyboard behavior consistent.                                                       |
| Desktop navigation shortcuts and hints while the modifier key is held                         | [Sidebar](../../src/web/components/sidebar.tsx), [navigation](../../src/web/lib/navigation.ts)                                                             | Add contextual hints where an action is used.                                                      |
| Private entry with focus handling, app connection notices, and browser handoff controls       | [Private entry](../../src/web/components/private-entry.tsx), [chat](../../src/web/pages/chat.tsx), [handoff](../../src/web/components/browser-handoff.tsx) | Verify the return to the exact task and its final state.                                           |
| Desktop downloads save to Downloads and avoid name collisions                                 | [Desktop downloads](../../desktop/main/downloads.mjs)                                                                                                      | Add a successful-save receipt and native file drag.                                                |

## Recommended order

**First** means the best starting set. **Next** means a strong extension. **Later** means useful after the core interactions are consistent.

Effort is relative: **S** changes one main UI area; **M** crosses UI areas or needs server or desktop support; **L** needs a broader product contract. These are not delivery estimates.

**Gap** means the reviewed code lacks a dedicated path. **Extend** means a useful part already exists. **Verify** means behavior needs a running-app check before a change is justified.

| Rank | ID  | Interaction                                         | Type   | Platform                       | Effort | Main benefit                       |
| ---- | --- | --------------------------------------------------- | ------ | ------------------------------ | ------ | ---------------------------------- |
| 1    | D01 | Restore an unfinished draft after reload            | Gap    | Web, desktop, mobile web       | M      | Prevent lost work                  |
| 2    | D02 | Drag a real file from chat to the desktop           | Gap    | Desktop                        | M      | Make results useful outside nod    |
| 3    | D03 | Copy an image as image data                         | Gap    | Desktop and supported browsers | S–M    | Remove download and upload steps   |
| 4    | D04 | Copy formatted text and spreadsheet cells correctly | Extend | Web, desktop                   | M      | Preserve work across apps          |
| 5    | D05 | Drop files anywhere in the chat area                | Extend | Web, desktop                   | S      | Remove precise targeting           |
| 6    | D06 | Reuse an attachment in a new message                | Gap    | Web, desktop, mobile web       | M      | Remove repeated file handling      |
| 7    | D07 | Reply to selected text                              | Gap    | Web, desktop, mobile web       | M      | Make corrections precise           |
| 8    | D08 | Show visible Copy success and useful failure        | Extend | All app surfaces               | S      | Remove doubt                       |
| 9    | D09 | Complete a download with Open and Show in folder    | Extend | Desktop                        | M      | Close the file export flow         |
| 10   | D10 | Keep position and zoom for each preview             | Extend | Web, desktop, mobile web       | M      | Preserve reading context           |
| 11   | D11 | Edit a small value where it appears                 | Extend | Web, desktop, mobile web       | S–M    | Remove navigation and prompt steps |
| 12   | D12 | Make Undo consistent for reversible changes         | Extend | Web, desktop, mobile web       | M      | Make small mistakes inexpensive    |

D01 is the first quality need. D02 is the strongest visible demonstration. D03, D05, and D08 are the best early changes with limited scope.

Some entries will feel like expected behavior after their first use. Their value comes from removing a repeated interruption. Check each interaction on first use, repeated use, and failure. A useful surprise must remain useful on the tenth attempt.

## The first 12, in detail

### D01. Restore an unfinished draft

**Moment:** You write a long request, attach two files, then reload nod. The same draft returns with its reply target.

The current chat keeps its text in React state. Attachments live in composer state. Keeping chat mounted covers main-page navigation, but not reload or process restart.

Save a draft for the current owner and thread on that device. Restore uploaded attachment references after the server checks access. Mark an interrupted local upload as needing the file again. Never show it as ready.

Do not add automatic sending. Keep private entry values out of this store. Classify known verification replies before persistence. Exclude drafts from analytics and replay capture.

**Acceptance:** Reload with text, two uploaded files, and a task reply. All valid parts return. Another owner or a reset thread receives none of them.

### D02. Drag a real file out of chat

**Moment:** You drag `venue-comparison.pdf` from chat into a desktop folder. A PDF appears with the correct name and content.

Support the same action from the file card and preview. Use a normal file drag image and copy behavior. Canceling the drag leaves the original in nod.

The reviewed desktop bridge has no dedicated native drag method. Browser image dragging can supply partial behavior, but it does not establish reliable file export.

[Electron provides a native file drag API](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop). This makes the desktop proposal feasible. It still needs a prepared local file and tests on each supported operating system.

Prepare only the selected owned artifact through a narrow desktop path. Keep local paths and access credentials out of model input. Retain Download as the browser fallback.

**Acceptance:** Drag an image and a PDF to Finder or Explorer. Test cancellation, a repeated name, and an unavailable file. A failed preparation gives useful feedback.

### D03. Copy an image as an image

**Moment:** Select Copy image, then paste directly into an email draft, a document, or a design tool.

Copy image data, rather than an internal artifact address. Keep Download original as a separate action. Preserve image resolution and transparency where the clipboard format permits them.

The current file-panel Copy action covers selected text formats. It does not offer image copying.

[The Clipboard API supports image and multiple-format writes](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write). Permission, format, and browser limits still apply. Offer Download if copying fails. Never report success before the clipboard write completes.

**Acceptance:** Paste a transparent image into two target apps. It remains an image with usable resolution. Denied clipboard access produces a visible fallback.

### D04. Copy content in the form the next app needs

**Moment:** Copy a comparison table from nod into a spreadsheet. Rows and columns arrive in separate cells. Copy a draft into a document. Lists and links remain useful.

Use one main Copy action with plain-text and safe HTML representations. For a table, use tab-separated cells in the plain-text form. Keep Copy Markdown as an explicit secondary action.

Copy only the selected message, table, or draft. Do not include nearby explanation, timestamps, or controls. Preserve ordinary selected-text copying.

Current whole-message Copy writes the source message text. The clipboard source above establishes the multi-format mechanism; the exact formats and target apps need testing.

**Acceptance:** Paste a table into a spreadsheet, a list into a document, and the same content into a plain-text editor. Each result remains readable and correctly bounded.

### D05. Accept a file drop across the chat area

**Moment:** You drag a screenshot over the conversation. A clear drop target appears. You drop it without finding the small composer.

Add the file to the existing draft. Keep its text, reply target, and attachments. Show a local thumbnail at once. Upload it without sending the message.

The current file target is the composer form. Extend it to the chat area. Handle file drags only. Leave text selection, links, private forms, and browser handoff controls to their own interactions.

Clear the drop state on exit, cancellation, and drop. Prevent a missed file drop from replacing the chat with a browser file page.

**Acceptance:** Drop three files over a message. All join the draft once. A canceled drag leaves no overlay. A text drag does not start a file upload.

### D06. Reuse a file already in the conversation

**Moment:** Open a previous PDF and select Use in message. It appears beside your current draft. You type “Compare this with the new version.”

Add Use in message to the file menu and preview. On desktop, also allow a file card to be dragged into the composer. Reuse its artifact reference after an owner-access check.

Keep the draft's text and reply target. Do not replace them. Let the user remove the attachment before sending.

This avoids downloading and uploading the same file. The current composer accepts local files; it has no dedicated existing-artifact input.

**Acceptance:** Reuse a PDF without a new upload. A removed or inaccessible artifact produces an error beside that attachment.

### D07. Reply to a selected passage

**Moment:** Select one sentence in a long answer, choose Reply to selection, and type “Use November here.”

Keep the existing reply model, with a short exact quote and the source message. Show that quote above the composer. The reply goes to the source task when applicable.

For an attachment, the same pattern can later support an explicit file reference. Text selection inside canvas previews is separate work.

The current Reply action targets the full message. Avoid taking focus while the user is still selecting. Keep Copy selection available through normal platform behavior.

**Acceptance:** Quote one sentence while another task runs. The quote stays exact and the reply reaches only the intended session.

### D08. Give Copy a visible result

**Moment:** Select Copy. A brief Copied state appears at the control or message. You can paste with confidence.

The message menu currently closes after Copy. Its success notice is for screen readers. The file-panel copy handler silently catches failure, and a failed fetch can return without feedback.

Show success only after the write completes. Show a compact error and a manual-copy or download route on failure. Do not move focus or show a modal dialog.

Reuse this behavior for message text, blocks, files, and image copying. Keep the existing accessible announcement.

**Acceptance:** Test success and denied clipboard access. Both produce visible, accessible feedback at the place of action.

### D09. Close the download flow

**Moment:** Select Download. After saving, the file shows Saved to Downloads with Open and Show in folder.

The desktop download handler already selects Downloads and resolves duplicate names. It reports errors, but it has no matching successful-save callback to the UI.

Keep feedback attached to the file or in a quiet download notice. Reuse the actual completed path. Do not download a second copy when the user selects Show in folder.

Open requires an explicit user action and a defined policy for supported document types. Do not automatically launch executable or active content. In browsers, show download initiation without claiming that the operating system saved the file.

**Acceptance:** Save the same name twice. Each receipt points to its own completed file. An interrupted download never shows Saved.

### D10. Remember how each file was being read

**Moment:** Read page seven of a PDF, inspect an image, then return. The PDF is still on page seven at the same zoom.

Keep reading state for each artifact during the current conversation visit: PDF position and zoom, image zoom, selected sheet, and text position. The panel already remembers width.

Switching files should not erase those states. Avoid persistent content caches for this first version. If an artifact changes, discard its old reading state.

Provide an explicit reset to fit or start. File navigation must continue to respect text fields, media controls, and local scrolling.

**Acceptance:** Alternate between two PDFs and an image. Each returns to its own position. Closing the panel restores focus without scrolling the chat unexpectedly.

### D11. Edit the value at the point of use

**Moment:** Select a schedule's time or a memory note's Edit control. The editor opens in the same place, with the current value selected or the caret positioned usefully.

Schedule forms and memory editing already exist. Extend their entry points and make their behavior consistent. Use Enter for a single-line value, Command/Ctrl+Enter for multiline Save, and Escape for Cancel.

Show Saving and Saved beside the field. Keep the draft on failure. A read-only value should not resemble an editable control.

Keep explicit Save for schedule instructions, permissions, limits, and other consequential changes. Do not commit them through blur. Do not rewrite an executed request or approved action in place.

**Acceptance:** Change a time with the keyboard. Cancel another change. Simulate a failed save. Each result is clear and preserves the correct value.

### D12. Extend Undo where reversal is real

**Moment:** Remove an unsent attachment or change schedule timing. A nearby Undo action restores the prior state.

Schedule timing and pause already have an Undo notice. Extend a small, explicit set of reversible changes. Scope Undo to the edited object. Keep text-editor Undo separate.

Pause notice expiry while the pointer or keyboard focus is inside it, and while the app is hidden. Check the current object revision before reversal. Avoid overwriting a newer change.

Undo restores a local or nod-owned state. It cannot unsend mail, reverse a completed checkout, restore a forgotten secret, or reverse a schedule run that already started.

**Acceptance:** Change schedule timing, Undo it, then change it elsewhere and try an old Undo. The stale reversal does not overwrite the newer value.

## The next 20 changes

These are bounded extensions. Some are consistency checks for behavior that already exists.

| ID  | Priority and effort | Moment and recommended behavior                                                                                                                    | Current evidence and acceptance check                                                                                                                                                                   |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D13 | First, S            | **Accept valid files in a mixed batch.** Drop five files, one too large. Keep the four valid files and identify the rejected one.                  | `upload()` currently rejects the full batch if any file exceeds the limit. Check that valid files upload once and the draft remains intact.                                                             |
| D14 | Next, M             | **Show delivery state per message.** Distinguish sending to nod, received, and waiting for the current turn.                                       | Chat already uses optimistic messages and client message IDs. Expose the distinction without implying that an outside action completed. Check a lost acknowledgement without creating a second message. |
| D15 | First, S            | **Copy one useful block.** Give a code block or clearly defined draft a local Copy action.                                                         | Whole-message Copy exists. Copy a block without code fences, surrounding explanation, or the next paragraph. Do not guess draft boundaries from prose.                                                  |
| D16 | Next, S             | **Choose Enter behavior.** Offer Enter to send or Enter for a new line, with Command/Ctrl+Enter to send.                                           | The composer already checks input-method composition before sending. Preserve that protection. Test a multiline list and an input method that uses Enter to choose characters.                          |
| D17 | Next, M             | **Give files a useful context menu.** Offer Preview, Copy image where applicable, Download, and Use in message. Prefer the system menu on desktop. | Messages have a custom menu. Files mainly expose open and download controls. Check right-click, the menu button, and keyboard access to the same available actions.                                     |
| D18 | First, S            | **Respect a selected passage on right-click.** Keep native Copy and other platform actions when text is selected.                                  | The message-body context handler does not check the current text selection. Check that the custom message menu does not replace the user's selected-text actions.                                       |
| D19 | Next, S–M           | **Preview a schedule's next run before Save.** Show the exact date, time, and time zone below the edited value.                                    | Schedule timing is already editable. Check weekday, monthly, and daylight-saving cases against the server's schedule rules. A local guess must not disagree with execution.                             |
| D20 | First, S            | **Keep a failed edit in place.** Preserve text and focus. Put the error beside the field and retain Save.                                          | Memory forms already keep draft state on failure. Verify each edit surface and fix only inconsistent cases. Retry a failed state save without repeating a completed outside action.                     |
| D21 | Later, M            | **Rename a title without changing the work.** Use a small inline editor for a schedule title or task display name.                                 | Task cards display model-supplied titles; timing forms do not edit the title. Keep the original request and task goal separate. Check that a rename changes metadata only.                              |
| D22 | Next, M             | **Jump from a reply quote to its source, then return.** Briefly identify the source and keep a Return control.                                     | Task links and the message rail can already focus messages. Reply quotes are static. Check a source outside the loaded history and restoration of the prior scroll position.                            |
| D23 | Next, S–M           | **Make Escape close one layer.** Close the innermost menu or editor before its parent panel.                                                       | Several surfaces handle Escape independently. Test a menu inside a preview and a nested dialog. Closing a view must not decline an approval, send a message, or stop a task.                            |
| D24 | First, S            | **Make Stop scope explicit.** Identify the main control as Stop all work and a task control as Stop this task.                                     | Main Stop closes open tasks; the composer label is Stop nod. Make scope clear before activation. Keep Stop immediate and show Stopping until the server confirms.                                       |
| D25 | Next, verify        | **Return focus to the next useful place.** Closing a preview returns to its file; completing an edit returns to its value.                         | File previews, private entry, and Settings already contain focus recovery. Check the full paths before adding code. A background update must not take focus from current typing.                        |
| D26 | Next, S–M           | **Jump directly to a file.** Select the current filename to choose another loaded conversation file.                                               | The viewer already has previous and next navigation. Keep those controls. Check long filenames and two files with the same name. Avoid a new file-management page.                                      |
| D27 | Next, M             | **Keep task rows steady during interaction.** A live status update must not move the row under the pointer or keyboard focus.                      | Tasks are ordered by status. Verify whether updates move an active target. Retain the active row until interaction ends, then apply the new order.                                                      |
| D28 | Next, M             | **Open the actual result from its receipt.** A completed event or document result offers Open in app or Open file when a verified target exists.   | Task activity and attachments already expose results separately. Use a provider-returned target or owned artifact. Test that the target is the completed object, not a guessed URL.                     |
| D29 | Next, verify/M      | **Return from app connection to the pending task.** Preserve the draft and reply target, then show the actual connected state.                     | Connection success notices and focus checks already exist. Test a slow callback and a second open task. Continue the waiting session through the existing contract; do not blindly replay an action.    |
| D30 | Next, M             | **Give a confirmation a final state.** The original request shows waiting, declined, completed, or outcome unclear as the server records it.       | Confirmations already have strict binding and single-use rules. Check a restart, a stale browser tab, and an uncertain result. The UI must not offer a second execution.                                |
| D31 | Next, verify/M      | **Show that browser handoff is complete.** After Done, acknowledge the handoff and expose the resumed task's real state.                           | Done, Finishing, and browser status already exist. Verify the transition after the handoff closes. Repeated Done and a delayed response must not resume the task twice.                                 |
| D32 | Next, verify/M      | **Recover the view after connection loss.** Keep the draft, reading position, and honest message state while updates reconnect.                    | The app already shows Reconnecting and recovers state. Check server receipt before offering a resend. Reconnect may refresh state; it must not repeat a turn or outside action.                         |

## Four useful ideas with larger scope

These fit the same direction, but they need more than a small interaction change. Keep them separate from the first delivery set.

| Idea                                                                  | Why it is useful                                                                               | Why to defer it                                                                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search the whole conversation**, with result navigation and Return  | One continuing conversation makes old details valuable. Browser Find sees only loaded content. | Owner-scoped search already exists for the agent in [personal actions](../../src/server/personal.ts). Needs a UI route, result loading, and clear search bounds. M–L. |
| **A contextual command menu** for the selected message, file, or task | It can unify existing pointer actions and shortcuts. Linear provides a useful reference.       | Needs consistent selection, focus, and a command inventory. Start with existing actions only. M–L.                                                                    |
| **Edit a copy of generated text in the preview**                      | You can fix one sentence without another model request.                                        | Needs saved versions and clear separation between an output copy, the transcript, and pending approvals. Start with plain text or Markdown. L.                        |
| **Select and export several files**                                   | Repeated single-file downloads become slow after a large result.                               | Needs a selection model, aggregate export, naming rules, and partial-failure behavior. A ZIP export is a useful first scope. M–L.                                     |

## Interaction rules for the whole set

These rules are acceptance criteria, not extra features.

- **Act at the point of use.** Put the control and its feedback beside the selected object.
- **Keep the current work.** Preserve text, selection, reply target, scroll position, and valid attachments when the operation does not replace them.
- **Acknowledge at once.** Aim for local input feedback within about 100 ms. Treat this as a target, not a measured nod result.
- **Confirm the real state.** Distinguish pending, saved, submitted, and completed. Use the server's recorded state for outside work.
- **Keep all input methods usable.** Support pointer, keyboard, and touch. Do not make hover or dragging the only route.
- **Use predictable keys.** Do not intercept editing keys, browser shortcuts, media controls, or input-method composition.
- **Keep motion short and optional.** Use it to explain a state change. Respect reduced motion and keep actions available.
- **Keep error recovery local.** Retain valid input. Explain which item failed and what action is available.
- **Give notices enough time.** Pause an actionable notice while it is hovered, focused, or hidden by app switching.
- **Keep device limits clear.** Desktop can promise a native file operation after completion. Web and chat channels need their own supported routes.

## Boundaries that matter for nod

The interaction can become shorter without changing who authorizes an action.

1. Do not edit an approved action's arguments behind its confirmation. A changed draft needs a newly checked action.
2. Do not treat closing a panel as approval, refusal, or cancellation of work. Keep view state separate from execution state.
3. Do not add automatic retry to a turn, an outside action, a payment, or an uncertain result.
4. Use Undo only for a change with a defined reversal. It does not reverse effects that already occurred outside nod.
5. Keep private entry outside chat drafts, clipboard helpers, screenshots, analytics, and model input.
6. Keep the file-preview sandbox. Rich copy must use safe content. Native export must accept owned artifact IDs, not arbitrary host paths.
7. Keep a reply bound to its selected task. A more convenient control must not send the reply to a different session.
8. Use model-written text through the existing communication path for confirmations and handoffs. Do not add fixed confirmation wording.

These are existing product contracts to preserve, not proposals for extra approval steps.

## Suggested delivery groups

### First group: remove doubt and lost work

Deliver D08, D13, D18, D20 where inconsistent, and D24. Add D01 as the main state-preservation change.

This group improves frequent actions and makes the later features safer to use. It also gives a consistent feedback pattern for Copy and file handling.

### Second group: make files move naturally

Deliver D03, D04, D05, D06, and D09. Prove D02 with a focused native drag prototype, then complete it on supported desktop systems.

The desktop preparation and completed-file handling for D09 can inform D02. Do not expose a generic filesystem bridge.

### Third group: preserve context while editing and reading

Deliver D07, D10, D11, D12, D19, and D22. Verify focus, Escape, task ordering, and connection recovery as part of those flows.

Keep the larger four ideas separate until these interactions are consistent.

## How to judge whether it feels better

Use synthetic data and disposable state. Do not call a live model or connected account for these checks.

| Task                                        | What to observe                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Copy an image into another app              | The user gets image data without finding and uploading a downloaded file. |
| Drag a PDF to a desktop folder              | The expected file appears once, with the correct name and content.        |
| Drop several files on the conversation      | The user does not hunt for a target. Valid files remain visible.          |
| Reload an unfinished request                | The user can continue without reconstructing the draft.                   |
| Copy a table into a spreadsheet             | Cells arrive correctly without manual cleanup.                            |
| Correct a sentence from a task result       | The selected passage and task remain clear.                               |
| Switch among three previews                 | The user continues reading at the same positions.                         |
| Save an edit with an induced error          | The draft remains available and the recovery action is clear.             |
| Approve an action during a delayed response | The same action cannot run twice. The UI reports recorded state.          |
| Use the flows by keyboard and touch         | No required control depends on hover or a drag gesture.                   |

Observe people who are new to nod and people who use it often. Record hesitation, workarounds, lost context, repeated actions, and unexpected results. Time saved is useful, but it is not the only signal.

Keep a short weekly review of these complete flows. [Linear describes its Quality Wednesdays](https://linear.app/now/designing-remote-work-at-linear) as a regular practice for finding small defects. For nod, review one flow from input through result and recovery. Maintain that flow before adding more gestures.

If analytics are added during implementation, use bounded operation and outcome values. Keep content, filenames, URLs, task text, and exact clipboard data out of events. Update the documented event list with that change.

### Five demonstrations worth aiming for

1. Drag a PDF from nod onto the desktop. Open the real PDF.
2. Copy a transparent image. Paste it into another app with its transparency intact.
3. Copy a comparison table. Paste it into spreadsheet cells with no cleanup.
4. Reload a draft with attachments. Continue writing at the same reply target.
5. Correct one small value in place. Undo it without leaving the page.

These demonstrate the proposed quality directly, with no layout or theme change.

## Assessment validation

- **Source review:** Completed for the areas named above.
- **Visual review:** Three existing synthetic screenshots inspected. No new UI behavior was tested.
- **Fixtures:** The isolated repository integration run passed 564 of 565 tests. The concurrent private-object writer test in `tests/downloads.test.ts` failed with a storage-unavailable error. The delighter acceptance checks remain proposed checks.
- **Live checks:** None. No model, connected account, recipient, or normal local database was used.
- **Implementation:** No application behavior changed. This file is a research report outside the published docs content tree.
- **Report checks:** Formatting passed. All local source links resolve.
- **Docs build:** Passed, including the published site's internal-link check.
- **App build:** Passed through the integration runner's `pnpm run build` step.
- **Repository check:** Types and architecture passed. Formatting failed on 63 existing files under the untracked `output/` directory. Those files were left unchanged.
