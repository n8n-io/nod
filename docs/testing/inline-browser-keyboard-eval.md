# Inline browser keyboard acceptance

Frozen on 2026-10-08 for [LAB-557](https://linear.app/n8n/issue/LAB-557), using the supplied agent-eval-loop method.

User task: “I cant type an @ symbol to the inline browser for logging into a site.”

The case uses the real `BrowserHandoff` component, synthetic layout-resolved keyboard events, the browser provider, and a disposable local Chromium page. The independent answer key is the destination field value and focus, read from Chromium after queued input completes. No model, account, credentials, or external recipient is used. This is a browser integration check; physical macOS keyboard layout and installed-release acceptance remain separate.

## Frozen cases and checks

| Case     | Input variation                                                                           | Required observable result                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| KEY01.v1 | Option-generated `@` inside a synthetic email address                                     | TEXT: the destination contains the complete address, including `@`, exactly once.                                                          |
| KEY02.v1 | AltGraph-generated `@` with Control and Alt set; another Option-generated symbol          | TEXT: the destination contains the resolved characters exactly once.                                                                       |
| KEY03.v2 | Ordinary and Shift-generated text; Control/Command+A; Backspace; Tab and Shift+Tab; paste | EDIT: selection and deletion affect the destination field; FOCUS: Tab moves focus and Shift+Tab restores it; PASTE: text is inserted once. |
| KEY04.v1 | Alt navigation and Control+Alt shortcuts without AltGraph                                 | SHORTCUT: unsupported modifier combinations do not insert text or navigate the destination.                                                |

All listed checks are required for their case, scored by code against the destination page. Every required check must pass in the same run. Measurement errors and missing browser dependencies are not passes. Run once before the fix and once after, then repeat the unchanged suite in full integration and final-commit CI. The behavior is deterministic; model cost is not applicable. Each focused run has a 120-second limit.

## Red hypothesis

The handler rejects all `altKey` events before considering their resolved character. The prediction is a destination email missing `@` for Option and AltGraph input while ordinary text succeeds. A correctly populated destination on the unchanged component would disprove this hypothesis.

The proposed fix handles resolved printable text before rejecting unsupported Alt shortcuts. It does not select a keyboard layout or special-case `@`. Existing Command/Control shortcuts and paste keep their paths. Composition and dead-key support are outside this case.

## Attempts

Base implementation: `7c097be74846f3fb909596d50bbe4dccf17ce90b`.

Attempt 1 on the unchanged base reproduced KEY01 and KEY02: `loginexample.test` instead of `login@example.test`, and empty text instead of `@€ł`. KEY03.v1 failed because its answer key assumed Shift+Tab leaves the caret at the end. Chromium selects the returned field instead. This is an evaluator fault, not a product failure. KEY03.v2 explicitly verifies returned focus and presses ArrowRight to collapse the selection before appending. The original attempt is retained in `red.log`; the corrected suite is frozen again before the implementation changes.

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
