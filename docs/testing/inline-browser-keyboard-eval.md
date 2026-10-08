# Inline browser keyboard acceptance

Frozen on 2026-10-08 for [LAB-557](https://linear.app/n8n/issue/LAB-557), using the supplied agent-eval-loop method.

User task: “I cant type an @ symbol to the inline browser for logging into a site.”

The case uses the real `BrowserHandoff` component, synthetic layout-resolved keyboard events, the browser provider, and a disposable local Chromium page. The independent answer key is the destination field value and focus, read from Chromium after queued input completes. No model, account, credentials, or external recipient is used. This is a browser integration check; physical macOS keyboard layout and installed-release acceptance remain separate.

## Frozen cases and checks

| Case     | Input variation                                                                              | Required observable result                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| KEY01.v1 | Option-generated `@` inside a synthetic email address                                        | TEXT: the destination contains the complete address, including `@`, exactly once.                                                          |
| KEY02.v1 | AltGraph-generated `@` with Control and Alt set; another Option-generated symbol             | TEXT: the destination contains the resolved characters exactly once.                                                                       |
| KEY03.v3 | Ordinary and Shift-generated text; Control/Command+A; Backspace; Tab and Shift+Tab; paste    | EDIT: selection and deletion affect the destination field; FOCUS: Tab moves focus and Shift+Tab restores it; PASTE: text is inserted once. |
| KEY04.v2 | Alt navigation, Control+Alt without AltGraph, and bare Alt+letter/digit on Linux and Windows | SHORTCUT: unsupported modifier combinations do not insert text or navigate the destination.                                                |

All listed checks are required for their case, scored by code against the destination page. Every required check must pass in the same run. Measurement errors and missing browser dependencies are not passes. Run once before the fix and once after, then repeat the unchanged suite in full integration and final-commit CI. The behavior is deterministic; model cost is not applicable. Each focused run has a 120-second limit.

## Red hypothesis

The handler rejects all `altKey` events before considering their resolved character. The prediction is a destination email missing `@` for Option and AltGraph input while ordinary text succeeds. A correctly populated destination on the unchanged component would disprove this hypothesis.

The fix handles resolved printable text before rejecting unsupported Alt shortcuts. Bare Option characters are accepted on Apple platforms; explicit AltGraph characters are accepted on all platforms. It does not select a keyboard layout or special-case `@`. Existing Command/Control shortcuts and paste keep their paths. Composition and dead-key support are outside this case.

## Attempts

Base implementation: `7c097be74846f3fb909596d50bbe4dccf17ce90b`.

Attempt 1 on the unchanged base reproduced KEY01 and KEY02: `loginexample.test` instead of `login@example.test`, and empty text instead of `@€ł`. KEY03.v1 failed because its answer key assumed Shift+Tab leaves the caret at the end. Chromium selects the returned field instead. This is an evaluator fault, not a product failure. KEY03.v2 explicitly verifies returned focus and presses ArrowRight to collapse the selection before appending. The original attempt is retained in [red.txt](inline-browser-keyboard/red.txt); the corrected suite is frozen again before the implementation changes.

| Attempt | Build                                        | Base              | Holdout           | Editing, paste and ignored shortcuts | Outcome |
| ------- | -------------------------------------------- | ----------------- | ----------------- | ------------------------------------ | ------- |
| 1       | Unchanged base plus test v1                  | Fail: missing `@` | Fail: empty value | Evaluator error described above      | Fail    |
| 2       | Unchanged base plus test v2                  | Fail: missing `@` | Fail: empty value | Pass                                 | Fail    |
| 3       | Base plus the handler fix, unchanged test v2 | Pass              | Pass              | Pass                                 | Pass    |

Attempt 2 ran at 2026-10-08T09:51:45Z (2.28 seconds including runner startup); attempt 3 ran at 2026-10-08T09:52:01Z (2.11 seconds). Both used Node 24.21.0 and real Chromium in an isolated Docker container with `--network none`. The focused run reported four passing tests, including its parent, with zero failures or skips.

SHA-256 identifiers:

- Frozen test v2: `83b445bda1d6200e0b797027a78b034a66910a7d921779d55212b6d63e0e5113`.
- Original handler: `42247c31f0187ada450458a69a07b3184288641be62ef7513754fbf7bd6dfd1d`.
- Fixed handler: `aeede9c99bcce9a8b13f314859b54876d25f08b49c8dcf76ee9f20d16ebcd238`.
- Preserved attempt 1 log: `fefb1a1ff5ea786d919a40b01025f9ba5b69f58ba6e8a859a8078e39f595fb21`.
- Preserved attempt 2 log: `702e4107f9fd982787e1c74fcc29b31bcfc9fb946cc72706f0dfec3f20434068`.
- Passing attempt 3 log: `690bc8c472708dddb01989a45956b2bd8d36e6440d3b25c414bec8e74ed9a695`.

Run the committed cases with `npm run test:integration`. The focused test name is `native handoff keyboard input preserves layout characters, editing and paste`. Full validation and the exact commit's CI are recorded on the pull request. These checks do not claim physical keyboard-layout, live account, or installed-release verification.

## Independent review and expanded platform checks

Review found that the first fix could turn bare Alt shortcuts on Windows/Linux into text. KEY04.v2 adds Linux and Windows platform cases asserting Alt+f and Alt+1 remain unprevented and insert nothing. KEY03.v3 strengthens the paste check: capture the destination before Command/Ctrl+V, require both shortcuts to remain unprevented, and then verify exactly one paste. The original version results above remain historical.

The hypothesis predicted both non-Apple cases would fail on commit `9f3f1baf8cedf8021defe49d5b67368c5fa38354`. [The expanded red run](inline-browser-keyboard/platform-red.txt) confirmed both failures while the original three cases passed. Restricting bare Option text to Apple platforms fixed the regression; [the unchanged expanded cases](inline-browser-keyboard/platform-green.txt) then passed all five scenarios (six tests including the parent, zero failures or skips). Runtime remains Linux Chromium; client platform and key events are synthetic.

- Frozen test file SHA-256 before upstream synchronization: `fb8c96f4bdf5ecfc52a3f767daadabb447d52a3d147926527ffbfe91816e4ed7`.
- Final handler SHA-256: `48eeced2c81cc807d2ae1cf99376930d8b2741b13599f2de28c2a99318c17c76`.

Preserved logs: [original red](inline-browser-keyboard/red.txt), [corrected evaluator red](inline-browser-keyboard/red-v2.txt), [initial fix green](inline-browser-keyboard/green.txt), [platform regression red](inline-browser-keyboard/platform-red.txt), and [platform fix green](inline-browser-keyboard/platform-green.txt).

## Issue attachment review

The attached diagnostic report was inspected privately, and its SHA-256 matches the issue receipt. It confirms a successful browser-session open followed by a user turn waiting for manual sign-in. The four failed turns in its window were earlier interrupted background work. Browser snapshots are redacted, detailed tool capture is disabled, and the saved-session report is truncated; it contains no keyboard events or layout metadata. It supports the handoff context but cannot identify the physical key combination.

The source at the reported release commit, `1fb6efae39411a4c049ac7b892e188c81a43480b`, contains the same blanket `altKey` rejection as the reproduced baseline. Root-cause evidence therefore comes from the reported source plus the preserved Chromium reproduction, rather than inferring keystrokes from the attachment. No private report payload, page content, or account data is committed.

After synchronizing with newer main, the frozen keyboard test block is unchanged (SHA-256 `5492aabe8322f87df79845e6d456747e265d93f6f53342bea9a548e46687f9bf`); only surrounding upstream tests changed.
