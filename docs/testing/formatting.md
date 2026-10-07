# LAB-543 selection formatting

The user approved the interactive prototype on 2026-10-07. Chat and feedback share the selection toolbar, link editing, bold, italic, underline, heading selection, lists and keyboard behavior. Selecting all waits 300 ms before a 140 ms fade; explicit Tab and link shortcuts bypass the delay. Reduced motion disables the fade.

## Frozen acceptance cases

One browser run per case and applicable input, using synthetic content with the production React components. A case passes only when every listed observation holds. API responses are controlled; no model, real recipient, normal database or connected account is used. The original prototype observations are design evidence only.

| Case | Action                                                                                         | Required observations                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01  | Select all, then immediately replace; repeat and wait                                          | Brief selections show no toolbar; stable selections reveal all controls; immediate Tab and Command/Control+K focus controls.                               |
| F02  | Combine bold, italic, underline and link on selected words; submit and restore a rejected send | Outside text unchanged; transmitted Markdown and rendered submission preserve marks; restored draft preserves the same content.                            |
| F03  | Select part of a soft-break-separated line and apply a heading, then undo                      | Only the selected words become heading text; outside lines and marks remain; one undo restores the draft.                                                  |
| F04  | Type `- ` and `1. ` after a soft break, then Shift/Alt+Enter                                   | Correct list starts and continues without submitting; empty item exits; heading newline returns to paragraph.                                              |
| F05  | Format feedback, close/reopen, then submit with a pasted attachment                            | Owner draft restores marks; ordinary Enter continues writing; Command/Control+Enter submits once; attachment is included once; pending editor is readonly. |
| F06  | Keyboard menu/link navigation, narrow viewport and reduced motion                              | Pointer-open menu has no forced focus ring; arrows and Escape work; menu fits viewport and feedback dialog; motion preference respected.                   |

Held-out inputs use a reversed multiline selection and numbered list starting at 3. The focused existing integration tests cover send restoration, owner-scoped feedback drafts, file handling, character limits and safe rendered markup. Full project checks and CI are separate delivery gates.

## Results

| Case | Result             | Evidence                                                                                                                                                                                                                                                 |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01  | Pass               | Both real inputs initially had no menu after select-all; quick replacement stayed hidden. Tab and Command+K opened controls immediately.                                                                                                                 |
| F02  | Pass               | Browser submission captured `Before [***<u>selected words</u>***](https://example.com/release) after`; both the rendered receipt and rejected-send restoration retained the link, bold, italic and underline.                                            |
| F03  | Pass               | Chat produced paragraph / selected H2 / paragraph from soft breaks, then restored the original single paragraph with one undo. Feedback formatted only selected words and retained underline and bold after closing/reopening.                           |
| F04  | Pass               | Browser bullet creation/continuation/exit used both Alt and Shift. Mounted production Tiptap checks also covered numbered lists starting at 1 and 3, task lists, heading exit and IME submission guards.                                                 |
| F05  | Pass               | Browser feedback submission retained the restored heading and marks. Existing integration cases exercise mixed text/file paste once, file drop, frozen state, serialized limits and empty structured content.                                            |
| F06  | Pass after repairs | At 390 × 844, the feedback menu stayed inside the viewport and dialog; pointer-open rows had no outline, arrow navigation restored visible focus, and reduced motion computed to no animation. Keyboard Cancel and Escape preserved the feedback dialog. |

The initial implementation review found link-panel Enter incorrectly applying from Cancel/Remove, stale positions when either feedback scroll container moved, a toolbar left open after outside focus, unsupported blocks preventing conversion to Text, and empty structured feedback enabling submission. Each was repaired and checked against its owning behavior. Browser acceptance additionally exposed Radix handling Escape before the toolbar; a scoped capture handler now closes the formatting panel before the dialog.

One full Linux integration run passed 636 tests with no skips. Final project checks and the pull request's CI remain the authoritative delivery gates for the submitted revision. This evidence uses synthetic browser and integration fixtures; it does not claim native-shell acceptance or live feedback delivery. No model or connected-account evaluation ran. Tool traces and screenshots are retained with the task; local harness files are excluded from Git.
